import { readSync } from "node:fs"

const buffer = Buffer.alloc(1024)
while (true) {
  const size = readSync(0, buffer, 0, buffer.length, null)
  if (!size) break
  if (process.argv[2] === "close") {
    await Bun.write(Bun.stdout, buffer.subarray(0, 1))
    break
  }
  await Bun.write(Bun.stdout, buffer.subarray(0, size))
  // Yield between bounded reads to keep backpressure on the producer without a timed sleep.
  await new Promise<void>((resolve) => setImmediate(resolve))
}
