import { expect, test } from "bun:test"
import type { SessionNotFoundError } from "@opencode/client/promise"
import { Data } from "effect"
import { authFromToken, authTokenFromCredentials, createApiForServer, fileStreamUrl } from "./api"

test.each([
  [btoa("opencode:secret"), { password: "secret" }],
  [btoa("legacy:secret:with:colons"), { password: "secret:with:colons" }],
  [btoa(":secret"), { password: "secret" }],
  ["not base64", undefined],
  [btoa("missing-separator"), undefined],
])("authFromToken(%p) extracts only the password", (token, expected) => {
  expect(authFromToken(token)).toEqual(expected)
})

test("authTokenFromCredentials ignores usernames in legacy saved credentials", () => {
  const credentials = { username: "legacy", password: "secret" }
  expect(authTokenFromCredentials(credentials)).toBe(btoa("opencode:secret"))
})

test("concurrent deletions retain their own response status and request options", async () => {
  const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
  const requests: Request[] = []

  const api = createApiForServer({
    server: { url: "http://server.test/prefix", password: "fixture-password" },
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(url, init))

        return responses[requests.length - 1]!.promise
      },
      { preconnect() {} },
    ),
  })

  const controller = new AbortController()
  const first = api.session.remove({ sessionID: "ses_same" }, { headers: { "X-Request": "first" } })

  const second = api.session.remove(
    { sessionID: "ses_same" },
    { signal: controller.signal, headers: { "X-Request": "second" } },
  )

  const body = Data.taggedEnum<SessionNotFoundError>().SessionNotFoundError({
    sessionID: "ses_same",
    message: "Session not found",
  })

  expect(requests.map((request) => [request.method, request.url, request.headers.get("X-Request")])).toEqual([
    ["DELETE", "http://server.test/prefix/api/session/ses_same", "first"],
    ["DELETE", "http://server.test/prefix/api/session/ses_same", "second"],
  ])
  expect(requests.map((request) => request.headers.get("Authorization"))).toEqual([
    `Basic ${btoa("opencode:fixture-password")}`,
    `Basic ${btoa("opencode:fixture-password")}`,
  ])
  expect(requests.map((request) => request.headers.get("X-OpenCode-Capabilities"))).toEqual([null, null])
  controller.abort()
  expect(requests[1]!.signal.aborted).toBe(true)

  const reading = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const release = Promise.withResolvers<void>()

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reading.resolve(controller)

        return release.promise
      },
    },
    { highWaterMark: 0 },
  )

  responses[0]!.resolve(new Response(stream, { status: 401, headers: { "Content-Type": "application/json" } }))
  const writer = await reading.promise
  responses[1]!.resolve(Response.json(body, { status: 404 }))
  await expect(second).rejects.toMatchObject({ cause: { status: 404, body: { sessionID: "ses_same" } } })
  writer.enqueue(new TextEncoder().encode(JSON.stringify(body)))
  writer.close()
  release.resolve()
  await expect(first).rejects.toMatchObject({ cause: { status: 401, body: { sessionID: "ses_same" } } })
})

test("fileStreamUrl never puts a credential in a media URL", () => {
  const input = { path: "clips/final cut.mp4", directory: "/work/app" }
  expect(fileStreamUrl({ url: "http://127.0.0.1:4096", password: "secret" }, input)).toBeUndefined()
  expect(fileStreamUrl({ url: "http://127.0.0.1:4096" }, input)).toBe(
    "http://127.0.0.1:4096/api/fs/read/clips/final%20cut.mp4?location%5Bdirectory%5D=%2Fwork%2Fapp",
  )
})

test("only message and inbox reads ask for media refs, so other cross-origin requests stay unpreflighted", async () => {
  const requests: Array<{ path: string; headers: Headers }> = []

  const api = createApiForServer({
    server: { url: "https://server.example:4096", password: "secret" },
    // SAFETY: the API client only calls fetch with a URL and init, which this stub accepts.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        path: new URL(input instanceof Request ? input.url : input).pathname,
        headers: new Headers(init?.headers),
      })

      return Response.json({ data: [], cursor: {} })
    }) as typeof fetch,
  })

  await api.message.list({ sessionID: "ses_1" })
  await api.message.list({ sessionID: "ses_1" }, { mediaRefs: false, headers: { "X-Trace": "1" } })
  await api.session.message.get({ sessionID: "ses_1", messageID: "msg_1" })
  await api.session.inbox.list({ sessionID: "ses_1" }, { headers: { "X-Trace": "1" } })
  await api.session.list()

  expect(
    requests.map((request) => [
      request.path,
      request.headers.get("x-opencode-capabilities"),
      request.headers.get("authorization"),
    ]),
  ).toEqual([
    ["/api/session/ses_1/message", "experimental-media-uri", `Basic ${btoa("opencode:secret")}`],
    ["/api/session/ses_1/message", null, `Basic ${btoa("opencode:secret")}`],
    ["/api/session/ses_1/message/msg_1", "experimental-media-uri", `Basic ${btoa("opencode:secret")}`],
    ["/api/session/ses_1/inbox", "experimental-media-uri", `Basic ${btoa("opencode:secret")}`],
    ["/api/session", null, `Basic ${btoa("opencode:secret")}`],
  ])
  expect(requests[1].headers.get("x-trace")).toBe("1")
  expect(requests[3].headers.get("x-trace")).toBe("1")
})
