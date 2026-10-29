import {
  ClientError,
  OpenCode,
  type MessageListInput,
  type OpenCodeClient,
  type SessionInboxListInput,
  type SessionMessageGetInput,
} from "@opencode/client/promise"
import type { ServerConnection } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"
import { isSessionNotFoundError } from "./errors"

export function authTokenFromCredentials(input: { password: string }) {
  return btoa(`opencode:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)

  if (!decoded) return
  const separator = decoded.indexOf(":")

  if (separator === -1) return

  return {
    password: decoded.slice(separator + 1),
  }
}

export const MEDIA_URI_CAPABILITY = "experimental-media-uri"

export const CAPABILITIES_HEADER = "X-OpenCode-Capabilities"

/** `mediaRefs: false` reads stored media as inline bytes, for callers such as export that need self-contained messages. */
export type ServerRequestOptions = OpenCode.RequestOptions & { readonly mediaRefs?: false }

export function createApiForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  const fetch = input.fetch ?? globalThis.fetch

  const options = {
    baseUrl: input.server.url,
    fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            password: input.server.password,
          })}`,
        }
      : undefined,
  }

  const api = OpenCode.make(options)

  return withMediaRefs({
    ...api,
    session: {
      ...api.session,
      remove: (params, requestOptions) => {
        let status: number | undefined

        const request = OpenCode.make({
          ...options,
          fetch: Object.assign(
            async (...args: Parameters<typeof fetch>) => {
              const response = await fetch(...args)
              status = response.status

              return response
            },
            { preconnect: fetch.preconnect },
          ),
        })

        return request.session.remove(params, requestOptions).catch((error) => {
          if (error instanceof ClientError || !isSessionNotFoundError(error, params.sessionID)) throw error

          // The Promise client drops declared response statuses; retain this DELETE's status before accepting a 404.
          throw new Error(error instanceof Error ? error.message : undefined, { cause: { status, body: error } })
        })
      },
    },
  })
}

/**
 * Only the message and inbox reads can return stored media as `media:<hash>` refs, so only they carry the capability.
 * A custom header makes a cross-origin request preflighted, which every other request must keep avoiding.
 */
function withMediaRefs(api: OpenCodeClient) {
  return {
    ...api,
    message: {
      ...api.message,
      list: (input: MessageListInput, options?: ServerRequestOptions) =>
        api.message.list(input, mediaRefOptions(options)),
    },
    session: {
      ...api.session,
      message: {
        ...api.session.message,
        get: (input: SessionMessageGetInput, options?: ServerRequestOptions) =>
          api.session.message.get(input, mediaRefOptions(options)),
      },
      inbox: {
        ...api.session.inbox,
        list: (input: SessionInboxListInput, options?: ServerRequestOptions) =>
          api.session.inbox.list(input, mediaRefOptions(options)),
      },
    },
  }
}

function mediaRefOptions(options: ServerRequestOptions | undefined): OpenCode.RequestOptions | undefined {
  if (options?.mediaRefs === false) return options
  const headers = new Headers(options?.headers)
  headers.set(CAPABILITIES_HEADER, MEDIA_URI_CAPABILITY)

  return { ...options, headers }
}

/**
 * The server's ranged read of one file, for media elements. They cannot send the Authorization header, and a credential
 * never goes in a DOM URL, so a server that needs a password has none: its media downloads through the API instead.
 */
export function fileStreamUrl(server: ServerConnection.HttpBase, input: { path: string; directory: string }) {
  if (server.password) return

  const url = new URL(
    `api/fs/read/${input.path.split("/").map(encodeURIComponent).join("/")}`,
    server.url.endsWith("/") ? server.url : `${server.url}/`,
  )

  url.searchParams.set("location[directory]", input.directory)

  return url.href
}

export type ServerApi = ReturnType<typeof createApiForServer>
