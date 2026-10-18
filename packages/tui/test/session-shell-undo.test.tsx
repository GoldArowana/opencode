import { expect } from "bun:test"
import path from "node:path"
import { TextareaRenderable } from "@opentui/core"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { offlineModels } from "../../core/test/fixture/models"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { createAppFixture } from "./fixture/app"
import { waitForHighlightedFrame } from "./fixture/frame"
import { agent, model } from "./fixture/local"
import { json } from "./fixture/tui-client"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Session.node, LocationServiceMap.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    Global.node.replace(tempGlobalLayer),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    offlineModels,
  ]),
)

it.live("keyboard shell submission after undo renders real core completion without a chat prompt", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, "output.txt"), "visible-after-undo\n"))
    const session = yield* Session.Service
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const created = yield* session.create({ location: { directory: AbsolutePath.make(tmp.path) } })
    const boundary = yield* session.prompt({ sessionID: created.id, text: "Undo this", resume: false })
    yield* SessionInbox.promote(database.db, bus, created.id, "steer")
    yield* session.revert.stage({ sessionID: created.id, messageID: boundary.id, files: false })
    const run = Effect.runPromiseWith(yield* Effect.context())
    const location = { directory: tmp.path }
    const commands: string[] = []
    const setup = yield* Effect.promise(() =>
      createAppFixture({
        width: 100,
        height: 40,
        config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
        args: { sessionID: created.id },
        fetch: async (url, request) => {
          if (url.pathname === "/api/location") return json(location)
          if (url.pathname === "/api/agent") return json({ location, data: [agent("build")] })
          if (url.pathname === "/api/model") return json({ location, data: [model("local")] })
          if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Local" }] })
          if (url.pathname === "/api/session")
            return json({
              data: [Schema.encodeSync(SessionSchema.Info)(await run(session.get(created.id)))],
              cursor: {},
            })
          if (url.pathname === `/api/session/${created.id}`)
            return json({ data: Schema.encodeSync(SessionSchema.Info)(await run(session.get(created.id))) })
          if (url.pathname === `/api/session/${created.id}/message`)
            return json({
              data: (await run(session.messages({ sessionID: created.id }))).map((message) =>
                Schema.encodeSync(SessionMessage.Info)(message),
              ),
              cursor: {},
            })
          if (
            url.pathname === `/api/session/${created.id}/inbox` ||
            url.pathname === `/api/session/${created.id}/permission`
          )
            return json({ data: [] })
          if (url.pathname === `/api/session/${created.id}/shell`) {
            const body = await request.json()
            commands.push(body.command)
            await run(session.shell({ sessionID: created.id, command: body.command }))
            return new Response(null, { status: 204 })
          }
          if (request.method === "POST") throw new Error(`Unexpected mutation: ${url.pathname}`)
        },
      }),
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => setup[Symbol.asyncDispose]()))
    const events = yield* session.log({ sessionID: created.id, follow: true }).pipe(
      Stream.filter(
        (event) =>
          event.type === "session.revert.committed" ||
          event.type === "session.shell.started" ||
          event.type === "session.shell.ended",
      ),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const encoded = Schema.encodeSync(
            Schema.Union([SessionEvent.RevertEvent.Committed, SessionEvent.Shell.Started, SessionEvent.Shell.Ended]),
          )(event)
          expect(encoded.durable.version).toBe(1)
          setup.events.emit({ ...encoded, durable: { ...encoded.durable, version: 1 } })
        }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.promise(async () => {
      await setup.ready
      await setup.waitForFrame(
        (frame) =>
          frame.includes("1 message reverted") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
      )
      await setup.mockInput.typeText("!")
      await setup.waitForFrame((frame) => frame.includes("Shell"))
      await setup.mockInput.typeText("cat output.txt")
      await setup.waitForFrame(
        () =>
          setup.renderer.currentFocusedRenderable instanceof TextareaRenderable &&
          setup.renderer.currentFocusedRenderable.plainText === "cat output.txt",
      )
      setup.mockInput.pressEnter()
      const frame = await waitForHighlightedFrame(
        setup,
        (text) => text.includes("visible-after-undo") && !text.includes("1 message reverted"),
      )
      expect(frame).toContain("visible-after-undo")
      expect(frame).not.toContain("1 message reverted")
      expect(commands).toEqual(["cat output.txt"])
    })
    expect((yield* session.get(created.id)).revert).toBeUndefined()
    expect(yield* session.messages({ sessionID: created.id })).toMatchObject([
      { type: "shell", status: "exited", exit: 0, output: { output: expect.stringContaining("visible-after-undo") } },
    ])
    yield* Fiber.interrupt(events)
  }),
)
