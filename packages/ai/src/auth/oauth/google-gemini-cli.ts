/**
 * Gemini CLI OAuth flow (Google Cloud Code Assist).
 *
 * NOTE: This module uses node:http through the callback server. It is only
 * reachable through the lazily loaded OAuth flow loader.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const PROJECT_ENV_ERROR =
	"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
	"See https://goo.gle/gemini-cli-auth-docs#workspace-gca";

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: { cloudaicompanionProject?: { id?: string } };
}

function parseRedirectUrl(input: string): { code?: string; state?: string } {
	try {
		const url = new URL(input.trim());
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		return {};
	}
}

function isVpcScAffectedUser(payload: unknown): boolean {
	const details = (payload as { error?: { details?: Array<{ reason?: string }> } } | undefined)?.error?.details;
	return Array.isArray(details) && details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

async function discoverProject(accessToken: string, interaction: ProviderAuthInteraction): Promise<string> {
	const { signal } = interaction;
	const progress = (message: string) => interaction.notify({ type: "progress", message });
	const envProjectId = getProviderEnvValue("GOOGLE_CLOUD_PROJECT") || getProviderEnvValue("GOOGLE_CLOUD_PROJECT_ID");
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	progress("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
	});

	let data: LoadCodeAssistPayload;
	if (loadResponse.ok) {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	} else {
		const errorText = await loadResponse.text();
		let errorPayload: unknown;
		try {
			errorPayload = JSON.parse(errorText);
		} catch {}
		if (!isVpcScAffectedUser(errorPayload)) {
			throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
		}
		data = { currentTier: { id: TIER_STANDARD } };
	}

	if (data.currentTier) {
		const projectId = data.cloudaicompanionProject || envProjectId;
		if (projectId) return projectId;
		throw new Error(PROJECT_ENV_ERROR);
	}

	const tierId = data.allowedTiers?.find((tier) => tier.isDefault)?.id ?? TIER_LEGACY;
	if (tierId !== TIER_FREE && !envProjectId) throw new Error(PROJECT_ENV_ERROR);

	progress("Provisioning Cloud Code Assist project (this may take a moment)...");
	// Free tier must omit the project id so Google provisions a managed one.
	const withProject = tierId !== TIER_FREE && envProjectId;
	const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			tierId,
			...(withProject ? { cloudaicompanionProject: envProjectId } : {}),
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				...(withProject ? { duetProject: envProjectId } : {}),
			},
		}),
	});
	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
	}

	let operation = (await onboardResponse.json()) as LongRunningOperationResponse;
	for (let attempt = 1; !operation.done && operation.name; attempt++) {
		progress(`Waiting for project provisioning (attempt ${attempt + 1})...`);
		await new Promise((resolve) => setTimeout(resolve, 5000));
		signal.throwIfAborted();
		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operation.name}`, { headers, signal });
		if (!response.ok) throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		operation = (await response.json()) as LongRunningOperationResponse;
	}

	const projectId = operation.response?.cloudaicompanionProject?.id || envProjectId;
	if (projectId) return projectId;
	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
}

async function getUserEmail(accessToken: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal,
		});
		if (response.ok) return ((await response.json()) as { email?: string }).email;
	} catch {}
	return undefined;
}

async function requestToken(
	params: Record<string, string>,
	signal: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
		signal,
	});
	if (!response.ok) throw new Error(`Google token request failed: ${await response.text()}`);
	return (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

async function loginGeminiCli(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const callback = await startOAuthCallbackServer({
		providerName: "Google",
		host: CALLBACK_HOST,
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		state: verifier,
		complete: async (code) => code,
		signal: interaction.signal,
	}).catch(() => undefined);

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTH_URL}?${authParams.toString()}`,
			instructions:
				"Complete the sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the redirect URL here:",
			placeholder: REDIRECT_URI,
		});
		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseRedirectUrl(result.input);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("Missing authorization code");

		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const token = await requestToken(
			{ code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier },
			interaction.signal,
		);
		if (!token.refresh_token) throw new Error("No refresh token received. Please try again.");

		const email = await getUserEmail(token.access_token, interaction.signal);
		const projectId = await discoverProject(token.access_token, interaction);
		return {
			type: "oauth",
			refresh: token.refresh_token,
			access: token.access_token,
			expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		};
	} finally {
		callback?.close();
	}
}

export const geminiCliOAuth: OAuthAuth = {
	name: "Google Cloud Code Assist (Gemini CLI)",
	isSubscription: true,

	login: loginGeminiCli,

	async refresh(credential, signal) {
		if (!credential.projectId) throw new Error("Google Cloud credentials missing projectId");
		const token = await requestToken({ refresh_token: credential.refresh, grant_type: "refresh_token" }, signal);
		return {
			...credential,
			refresh: token.refresh_token || credential.refresh,
			access: token.access_token,
			expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
		};
	},

	// The stream implementation needs both the token and the project id.
	async toAuth(credential) {
		return { apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }) };
	},
};
