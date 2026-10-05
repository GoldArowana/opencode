import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { McpOAuth } from "@opencode/core/mcp/oauth"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Schedule, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node])))
const integrationID = Integration.ID.make("mcp_callback_test")
const methodID = Integration.MethodID.make("oauth")

const fixture = Effect.gen(function* () {
  const started = Promise.withResolvers<void>()
  const token = Promise.withResolvers<() => Response>()
  const requests: URLSearchParams[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          response_types_supported: ["code"],
        })
      if (request.method !== "POST" || url.pathname !== "/token") return new Response(null, { status: 404 })
      requests.push(new URLSearchParams(await request.text()))
      started.resolve()
      return (await token.promise)()
    },
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      token.resolve(() => Response.json({ access_token: "unused", token_type: "Bearer" }))
      server.stop(true)
    }),
  )
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  yield* integrations.transform((editor) => {
    editor.method.update({ integrationID, method: { type: "key" } })
    editor.method.update({
      integrationID,
      method: { type: "oauth", id: methodID, label: "Test MCP" },
      authorize: () =>
        McpOAuth.authorize({
          name: "Test MCP",
          config: new ConfigMCP.Remote({
            type: "remote",
            url: server.url.href,
            oauth: { client_id: "client", client_secret: "private-client-secret" },
          }),
          integrationID,
          methodID,
        }).pipe(Effect.provideService(Credential.Service, credentials)),
    })
  })
  yield* integrations.connection.key({ integrationID, key: "previous-key" })
  const previous = yield* credentials.list(integrationID)
  const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
  const authorization = new URL(attempt.url)
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "")
  callback.searchParams.set("code", "private-auth-code")
  callback.searchParams.set("state", authorization.searchParams.get("state") ?? "")
  const status = integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })
  const settled = status.pipe(
    Effect.repeat({ until: (value) => value.status !== "pending", schedule: Schedule.spaced("1 millis"), times: 1000 }),
  )
  const page = (url = callback) =>
    Effect.tryPromise(() => fetch(url, { headers: { Connection: "close" } })).pipe(Effect.exit, Effect.forkScoped)
  return { started, token, requests, integrations, credentials, previous, attempt, callback, status, settled, page }
})

it.live("waits for MCP token exchange before browser success and consumes repeated callbacks once", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const page = yield* test.page()
    yield* Effect.promise(() => test.started.promise)
    expect((yield* test.status).status).toBe("pending")
    expect(yield* test.credentials.list(integrationID)).toEqual(test.previous)
    const duplicate = new URL(test.callback)
    duplicate.searchParams.set("state", "wrong-state")
    duplicate.searchParams.set("error_description", "private-client-secret")
    const repeated = yield* Effect.promise(() => fetch(duplicate, { headers: { Connection: "close" } }))
    expect(repeated.status).toBe(409)
    expect(yield* Effect.promise(() => repeated.text())).not.toContain("private-client-secret")
    expect(page.pollUnsafe()).toBeUndefined()
    expect(test.requests).toHaveLength(1)
    test.token.resolve(() => Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" }))
    const result = yield* Fiber.join(page)
    const response = yield* result
    expect(response.status).toBe(200)
    const html = yield* Effect.promise(() => response.text())
    expect(html).toContain("Authorization successful")
    expect(html).toContain("Authorization for Test MCP is complete.")
    expect(html).not.toContain("now connected")
    expect(html).not.toContain("saved")
    expect((yield* test.settled).status).toBe("complete")
    expect(yield* test.credentials.list(integrationID)).toHaveLength(2)
    expect(test.requests[0]?.get("code")).toBe("private-auth-code")
    yield* test.integrations.oauth.complete({ integrationID, attemptID: test.attempt.attemptID })
    expect(test.requests).toHaveLength(1)
    expect(yield* test.credentials.list(integrationID)).toHaveLength(2)
  }),
)

for (const failed of [
  {
    status: 400,
    body: JSON.stringify({
      error: "invalid_grant",
      error_description: "private-auth-code private-client-secret private-token",
    }),
  },
  { status: 200, body: "invalid token response" },
]) {
  it.live(`reports MCP exchange failure to the browser without exposing provider details (${failed.status})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const page = yield* test.page()
      yield* Effect.promise(() => test.started.promise)
      test.token.resolve(() => new Response(failed.body, { status: failed.status }))
      const result = yield* Fiber.join(page)
      const response = yield* result
      expect(response.status).toBe(400)
      const html = yield* Effect.promise(() => response.text())
      expect(html).toContain("Authorization failed")
      expect(html).not.toContain("private-auth-code")
      expect(html).not.toContain("private-client-secret")
      expect(html).not.toContain("private-token")
      expect(html).not.toContain("Authorization successful")
      expect((yield* test.settled).status).toBe("failed")
      expect(yield* test.credentials.list(integrationID)).toEqual(test.previous)
      // The pinned SDK retries invalid_grant once; both replies must stay failures.
      expect(test.requests).toHaveLength(failed.status === 400 ? 2 : 1)
    }),
  )
}

for (const invalid of ["state", "denied", "code"]) {
  it.live(`rejects an invalid MCP callback without exchanging tokens (${invalid})`, () =>
    Effect.gen(function* () {
      const test = yield* fixture
      test.callback.searchParams.set("error_description", "private-auth-code private-client-secret private-token")
      if (invalid === "state") test.callback.searchParams.set("state", "wrong-state")
      if (invalid === "code") {
        test.callback.searchParams.delete("code")
        test.callback.searchParams.delete("error_description")
      }
      const page = yield* test.page()
      const result = yield* Fiber.join(page)
      const response = yield* result
      expect(response.status).toBe(400)
      const html = yield* Effect.promise(() => response.text())
      expect(html).toContain("Authorization failed")
      expect(html).not.toContain("private-auth-code")
      expect(html).not.toContain("private-client-secret")
      expect(html).not.toContain("private-token")
      const status = yield* test.settled
      expect(status.status).toBe("failed")
      if (invalid === "state") expect(status).toMatchObject({ message: "OAuth state mismatch" })
      expect(test.requests).toHaveLength(0)
      expect(yield* test.credentials.list(integrationID)).toEqual(test.previous)
    }),
  )
}

it.live("closes an MCP callback listener cancelled before browser approval", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    yield* test.integrations.oauth.cancel({ integrationID, attemptID: test.attempt.attemptID })
    const page = yield* test.page()
    expect(Exit.isFailure(yield* Fiber.join(page))).toBe(true)
    expect(test.requests).toHaveLength(0)
    expect(yield* test.credentials.list(integrationID)).toEqual(test.previous)
  }),
)

it.live("closes a pending MCP browser response when token exchange is cancelled", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const page = yield* test.page()
    yield* Effect.promise(() => test.started.promise)
    yield* test.integrations.oauth.cancel({ integrationID, attemptID: test.attempt.attemptID })
    test.token.resolve(() => Response.json({ access_token: "cancelled", token_type: "Bearer" }))
    expect(Exit.isFailure(yield* Fiber.join(page))).toBe(true)
    expect(yield* test.credentials.list(integrationID)).toEqual(test.previous)
    expect(yield* test.status.pipe(Effect.flip)).toBeInstanceOf(Integration.AttemptNotFoundError)
    expect(test.requests).toHaveLength(1)
  }),
)

it.live("closes an unanswered MCP callback when its owner scope is interrupted", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const scope = yield* Scope.fork(yield* Scope.Scope)
    const authorization = yield* McpOAuth.authorize({
      name: "Test MCP",
      config: new ConfigMCP.Remote({
        type: "remote",
        url: new URL(test.attempt.url).origin,
        oauth: { client_id: "client" },
      }),
      integrationID,
      methodID,
    }).pipe(Scope.provide(scope))
    const url = new URL(authorization.url)
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("code", "private-auth-code")
    callback.searchParams.set("state", url.searchParams.get("state") ?? "")
    yield* authorization.callback.pipe(Effect.forkIn(scope))
    const page = yield* test.page(callback)
    yield* Effect.promise(() => test.started.promise)
    yield* Scope.close(scope, Exit.failCause(Cause.interrupt()))
    expect(Exit.isFailure(yield* Fiber.join(page))).toBe(true)
  }),
)
