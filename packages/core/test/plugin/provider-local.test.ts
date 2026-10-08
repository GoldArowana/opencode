import { LLM } from "@opencode/ai"
import { compileRequest } from "@opencode/ai/route/client"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Document, Event, Info } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schedule, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.provideMerge(ModelResolver.layer, PluginTestLayer))
const decode = Schema.decodeUnknownSync(Info)
const locals = [
  {
    id: "ollama",
    load: async () => {
      const { make } = await import("@opencode/core/plugin/provider/ollama")
      return make
    },
  },
  {
    id: "lmstudio",
    load: async () => {
      const { make } = await import("@opencode/core/plugin/provider/lmstudio")
      return make
    },
  },
  {
    id: "vllm",
    load: async () => {
      const { make } = await import("@opencode/core/plugin/provider/vllm")
      return make
    },
  },
]

const eventually = <A, R>(effect: Effect.Effect<A, never, R>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Timed out waiting for value")),
    Effect.retry({ times: 3000, schedule: Schedule.spaced("1 millis") }),
  )

function configuration(
  id: string,
  baseURL: string,
  options: { apiKey?: string; package?: string; name?: string } = {},
) {
  return new Document({
    type: "document",
    info: decode({
      providers: {
        [id]: {
          ...(options.package === undefined ? {} : { package: options.package }),
          settings: { baseURL, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) },
          models: {
            configured: {
              modelID: "configured-api",
              name: options.name ?? "Configured model",
              capabilities: { tools: true },
              limit: { context: 123_456 },
              settings: { temperature: 0.2 },
            },
            override: { package: "@opencode/ai/providers/openai/chat" },
            disabled: { disabled: true },
          },
        },
      },
    }),
  })
}

function inventory(id: string, ready: boolean) {
  if (id === "vllm") return { data: ready ? [{ id: "discovered", owned_by: "vllm", max_model_len: 4096 }] : [] }
  if (id === "lmstudio")
    return {
      models: ready
        ? [
            {
              type: "llm",
              key: "discovered",
              display_name: "Discovered",
              loaded_instances: [],
              max_context_length: 4096,
            },
          ]
        : [],
    }
  return {
    models: ready
      ? [
          {
            name: "discovered",
            model: "discovered",
            modified_at: "2026-01-01T00:00:00Z",
            size: 1,
            digest: "digest",
            details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_K_M" },
          },
        ]
      : [],
  }
}

const show = { capabilities: ["completion"], model_info: { "llama.context_length": 4096 } }

const resolve = Effect.fn(function* (id: string, baseURL: string, apiKey?: string) {
  const models = yield* Model.Service
  const resolver = yield* ModelResolver.Service
  const model = yield* models.get(Provider.ID.make(id), Model.ID.make("configured"))
  if (!model) return yield* Effect.fail(new Error("Configured model missing"))
  const resolved = (yield* resolver.resolveModel(model)).model
  const request = LLM.request({ model: resolved, prompt: "Hello" })
  const prepared = yield* compileRequest(request)
  const headers = yield* resolved.route.auth.apply({
    request,
    method: "POST",
    url: `${baseURL}/chat/completions`,
    body: "{}",
    headers: Headers.empty,
  })
  expect(model).toMatchObject({ name: "Configured model", capabilities: { tools: true }, limit: { context: 123_456 } })
  expect(resolved.route.endpoint.baseURL).toBe(baseURL)
  expect(prepared.body.model).toBe("configured-api")
  expect(model.settings?.temperature).toBe(0.2)
  if (apiKey) expect(headers.authorization).toBe(`Bearer ${apiKey}`)
  if (!apiKey) expect(headers.authorization).toBeUndefined()
  expect(yield* models.get(Provider.ID.make(id), Model.ID.make("override"))).toMatchObject({
    package: "@opencode/ai/providers/openai/chat",
  })
  expect((yield* models.available()).some((item) => item.providerID === id && item.id === "disabled")).toBe(false)
})

describe("configured local providers", () => {
  for (const local of locals) {
    for (const failure of ["empty", "error"]) {
      it.live(`${local.id} resolves configured models during ${failure} discovery and after recovery`, () =>
        Effect.gen(function* () {
          const state = { ready: false, requests: 0 }
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                fetch(request) {
                  const path = new URL(request.url).pathname
                  if (path.endsWith("/health")) return new Response()
                  if (path.endsWith("/api/show")) return Response.json(show)
                  state.requests++
                  if (!state.ready && failure === "error") return new Response("Unavailable", { status: 503 })
                  return Response.json(inventory(local.id, state.ready))
                },
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          )
          const config = yield* Config.Test
          const plugin = yield* Plugin.Service
          const host = yield* PluginHost.make(plugin)
          const make = yield* Effect.promise(local.load)
          const models = yield* Model.Service
          const baseURL = `${server.url.origin}/proxy/v1`
          yield* config.setEntries([configuration(local.id, baseURL, { apiKey: "fixture-key" })])
          yield* make(server.url.origin, "10 millis").effect(host)
          yield* ConfigProviderPlugin.Plugin.effect(host)
          yield* eventually(
            Effect.sync(() => state.requests),
            (count) => count > 0,
          )
          yield* resolve(local.id, baseURL, "fixture-key")

          state.ready = true
          yield* eventually(models.get(Provider.ID.make(local.id), Model.ID.make("discovered")), (model) => !!model)
          yield* resolve(local.id, baseURL, "fixture-key")
        }),
      )
    }
  }

  for (const path of ["/api/tags", "/api/show"]) {
    it.live(`Ollama configured models survive ${path} timeout and discovery recovery`, () =>
      Effect.gen(function* () {
        const gate = Promise.withResolvers<void>()
        const state = { requests: 0 }
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              async fetch(request) {
                const current = new URL(request.url).pathname
                if (current === path) {
                  state.requests++
                  await gate.promise
                }
                return Response.json(current === "/api/show" ? show : inventory("ollama", true))
              },
            }),
          ),
          (server) =>
            Effect.promise(() => {
              gate.resolve()
              return server.stop(true)
            }),
        )
        const config = yield* Config.Test
        const plugin = yield* Plugin.Service
        const host = yield* PluginHost.make(plugin)
        const { make } = yield* Effect.promise(() => import("@opencode/core/plugin/provider/ollama"))
        const models = yield* Model.Service
        const baseURL = `${server.url.origin}/v1`
        yield* config.setEntries([configuration("ollama", baseURL)])
        yield* make(server.url.origin, "10 millis").effect(host)
        yield* ConfigProviderPlugin.Plugin.effect(host)
        yield* eventually(
          Effect.sync(() => state.requests),
          (count) => count > 0,
        )
        yield* resolve("ollama", baseURL)
        // A second held request proves the real one-second discovery timeout elapsed.
        yield* eventually(
          Effect.sync(() => state.requests),
          (count) => count >= 2,
        )
        yield* resolve("ollama", baseURL)
        expect(yield* models.get(Provider.ID.make("ollama"), Model.ID.make("discovered"))).toBeUndefined()
        gate.resolve()
        yield* eventually(models.get(Provider.ID.make("ollama"), Model.ID.make("discovered")), (model) => !!model)
        yield* resolve("ollama", baseURL)
      }),
    )
  }

  it.live("same-endpoint config reload preserves pending discovery, inventory and explicit overrides", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>()
      const state = { tags: 0 }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            async fetch(request) {
              if (new URL(request.url).pathname === "/api/show") return Response.json(show)
              state.tags++
              await gate.promise
              return Response.json(inventory("ollama", true))
            },
          }),
        ),
        (server) =>
          Effect.promise(() => {
            gate.resolve()
            return server.stop(true)
          }),
      )
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const { make } = yield* Effect.promise(() => import("@opencode/core/plugin/provider/ollama"))
      const models = yield* Model.Service
      const providers = yield* Provider.Service
      const resolver = yield* ModelResolver.Service
      const providerID = Provider.ID.make("ollama")
      const baseURL = `${server.url.origin}/v1`
      yield* make(server.url.origin, "1 hour").effect(host)
      yield* ConfigProviderPlugin.Plugin.effect(host)
      yield* eventually(
        Effect.sync(() => state.tags),
        (count) => count === 1,
      )
      expect(yield* providers.get(providerID)).toBeUndefined()

      yield* config.setEntries([configuration("ollama", baseURL)])
      yield* bus.publish(Event.Updated, {})
      yield* eventually(models.get(providerID, Model.ID.make("configured")), (model) => !!model?.package)
      yield* resolve("ollama", baseURL)
      yield* config.setEntries([])
      yield* bus.publish(Event.Updated, {})
      yield* eventually(providers.get(providerID), (provider) => provider === undefined)

      gate.resolve()
      yield* eventually(models.get(providerID, Model.ID.make("discovered")), (model) => !!model)
      expect(yield* models.get(providerID, Model.ID.make("configured"))).toBeUndefined()
      yield* config.setEntries([
        configuration("ollama", baseURL, { package: "@opencode/ai/providers/openai/chat", name: "Renamed model" }),
      ])
      yield* bus.publish(Event.Updated, {})
      const model = yield* eventually(
        models.get(providerID, Model.ID.make("configured")),
        (model) => model?.name === "Renamed model",
      )
      if (!model) return yield* Effect.fail(new Error("Configured model missing"))
      expect(model.package).toBe("@opencode/ai/providers/openai/chat")
      expect((yield* resolver.resolveModel(model)).model.route.id).toBe("openai-chat")
      expect(yield* models.get(providerID, Model.ID.make("discovered"))).toBeDefined()

      yield* config.setEntries([])
      yield* bus.publish(Event.Updated, {})
      yield* eventually(models.get(providerID, Model.ID.make("configured")), (model) => model === undefined)
      expect(yield* models.get(providerID, Model.ID.make("discovered"))).toBeDefined()
      expect((yield* providers.get(providerID))?.package).toBe("@opencode/ai/providers/openai-compatible")
      expect(state.tags).toBe(1)
    }),
  )
})
