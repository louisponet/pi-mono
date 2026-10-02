import { googleGeminiCliApi } from "../api/google-gemini-cli.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadGeminiCliOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

// Cloud Code Assist serves a subset of the Gemini API catalog; reuse its metadata.
const MODEL_IDS = [
	"gemini-2.5-flash",
	"gemini-2.5-pro",
	"gemini-3-flash-preview",
	"gemini-3.1-flash-lite-preview",
	"gemini-3.1-pro-preview",
];

export function googleGeminiCliProvider(): Provider<"google-gemini-cli"> {
	const googleModels: readonly Model<"google-generative-ai">[] = Object.values(GOOGLE_MODELS);
	return createProvider({
		id: "google-gemini-cli",
		name: "Google Gemini CLI",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		auth: {
			oauth: lazyOAuth({
				name: "Google Cloud Code Assist (Gemini CLI)",
				isSubscription: true,
				load: loadGeminiCliOAuth,
			}),
		},
		models: googleModels
			.filter((model) => MODEL_IDS.includes(model.id))
			.map((model) => ({
				...model,
				name: `${model.name} (Cloud Code Assist)`,
				api: "google-gemini-cli" as const,
				provider: "google-gemini-cli",
				baseUrl: "https://cloudcode-pa.googleapis.com",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		api: googleGeminiCliApi(),
	});
}
