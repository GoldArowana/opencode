import { ClientError, OpenCode, type OpenCodeClient } from "@opencode/client/promise"
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

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
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

  return {
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
  }
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

export type ServerApi = OpenCodeClient
