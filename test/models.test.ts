import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { fetchBergetModels, mapModelToProviderConfig } from "../index";

describe("Model Fetching & Mapping", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test("mapModelToProviderConfig maps API response to ProviderModelConfig", () => {
    const apiModel = {
      id: "meta-llama/Llama-3.3-70B-Instruct",
      contextWindow: 128000,
      inputPricePerToken: 0.0000003,
      outputPricePerToken: 0.0000015,
    };

    const result = mapModelToProviderConfig(apiModel);

    expect(result.id).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(result.name).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(result.reasoning).toBe(false);
    expect(result.input).toEqual(["text"]);
    expect(result.cost).toEqual({
      input: 0.3,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(result.contextWindow).toBe(128000);
    expect(result.maxTokens).toBe(16384);
    expect(result.compat).toEqual({ supportsDeveloperRole: false });
  });

  test("fetchBergetModels returns mapped models from API", async () => {
    process.env.BERGET_API_URL = "https://test-api.berget.ai";

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/models/chat")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "meta-llama/Llama-3.3-70B-Instruct",
                contextWindow: 128000,
                inputPricePerToken: 0.0000003,
                outputPricePerToken: 0.0000015,
              },
              {
                id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
                contextWindow: 128000,
                inputPricePerToken: 0.0000001,
                outputPricePerToken: 0.0000003,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const models = await fetchBergetModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(models[0].cost.input).toBe(0.3);
    expect(models[0].cost.output).toBe(1.5);
    expect(models[0].compat).toEqual({ supportsDeveloperRole: false });
    expect(models[1].id).toBe("mistralai/Mistral-Small-3.2-24B-Instruct-2506");
    expect(models[1].input).toEqual(["text", "image"]);
    expect(models[1].cost.input).toBeCloseTo(0.1);
    expect(models[1].cost.output).toBeCloseTo(0.3);
  });

  test("fetchBergetModels returns empty array for empty models response", async () => {
    process.env.BERGET_API_URL = "https://test-api.berget.ai";

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const models = await fetchBergetModels();
    expect(models).toEqual([]);
  });

  test("fetchBergetModels throws on API failure", async () => {
    process.env.BERGET_API_URL = "https://test-api.berget.ai";

    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    await expect(fetchBergetModels()).rejects.toThrow("Failed to fetch models: 500");
  });

  test("mapModelToProviderConfig uses DEFAULT_MAX_TOKENS when not provided by API", () => {
    const apiModel = {
      id: "test-model",
      contextWindow: 32000,
      inputPricePerToken: 0,
      outputPricePerToken: 0,
    };

    const result = mapModelToProviderConfig(apiModel);
    expect(result.maxTokens).toBe(16384);
  });

  test("mapModelToProviderConfig calculates per-million-token costs correctly", () => {
    const apiModel = {
      id: "price-test",
      contextWindow: 128000,
      inputPricePerToken: 0.0000005,
      outputPricePerToken: 0.000002,
    };

    const result = mapModelToProviderConfig(apiModel);
    expect(result.cost.input).toBe(0.5);
    expect(result.cost.output).toBe(2.0);
  });

  // --- Override tests ---

  test("mapModelToProviderConfig applies vision override for known vision models", () => {
    const apiModel = {
      id: "google/gemma-4-31B-it",
      contextWindow: 262144,
      inputPricePerToken: 0.00000025,
      outputPricePerToken: 0.0000005,
    };

    const result = mapModelToProviderConfig(apiModel);
    expect(result.input).toEqual(["text", "image"]);
  });

  test("mapModelToProviderConfig applies reasoning override for known reasoning models", () => {
    const apiModel = {
      id: "openai/gpt-oss-120b",
      contextWindow: 128000,
      inputPricePerToken: 0.0000002,
      outputPricePerToken: 0.00000075,
    };

    const result = mapModelToProviderConfig(apiModel);
    expect(result.reasoning).toBe(true);
    expect(result.input).toEqual(["text"]);
  });

  test("mapModelToProviderConfig defaults unknown models to text-only without reasoning", () => {
    const apiModel = {
      id: "future-model-v99",
      contextWindow: 64000,
      inputPricePerToken: 0,
      outputPricePerToken: 0,
    };

    const result = mapModelToProviderConfig(apiModel);
    expect(result.input).toEqual(["text"]);
    expect(result.reasoning).toBe(false);
  });

  test("mapModelToProviderConfig preserves cost and contextWindow when applying override", () => {
    const apiModel = {
      id: "mistralai/Mistral-Medium-3.5-128B",
      contextWindow: 262144,
      inputPricePerToken: 0.0000015,
      outputPricePerToken: 0.000005,
    };

    const result = mapModelToProviderConfig(apiModel);

    expect(result.input).toEqual(["text", "image"]);
    expect(result.reasoning).toBe(true);
    expect(result.contextWindow).toBe(262144);
    expect(result.cost.input).toBe(1.5);
    expect(result.cost.output).toBe(5);
    expect(result.cost.cacheRead).toBe(0);
  });
});
