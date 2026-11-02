/**
 * Global setup: one Postgres container per test run, on a free port, removed afterwards.
 * Only the container started here is ever touched. Test files make their own databases in it, see database.ts.
 */
import { execFile } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"
import pg from "pg"
import type { TestProject } from "vitest/node"

declare module "vitest" {
    export interface ProvidedContext {
        databaseUrl: string
    }
}

const docker = async (...parameters: string[]) => (await promisify(execFile)("docker", parameters)).stdout.trim()

const attempts = 120
const pause = 500

const ready = async (url: string) => {
    for (let attempt = 1; ; attempt += 1) {
        const client = new pg.Client({ connectionString: url })
        try {
            await client.connect()
            await client.query("select 1")
            return
        } catch (error) {
            if (attempt === attempts) throw error
            await setTimeout(pause)
        } finally {
            await client.end().catch(() => undefined)
        }
    }
}

export default async function setup(project: TestProject) {
    const container = await docker(
        "run",
        "--detach",
        "--rm",
        "--env",
        "POSTGRES_PASSWORD=umwelt",
        "--publish",
        "127.0.0.1::5432",
        "postgres:18"
    )
    const remove = () => docker("rm", "--force", container)
    try {
        const port = (await docker("port", container, "5432/tcp")).split(":").at(-1)
        const url = `postgres://postgres:umwelt@127.0.0.1:${port}/postgres`
        await ready(url)
        project.provide("databaseUrl", url)
    } catch (error) {
        await remove()
        throw error
    }
    return async () => {
        await remove()
    }
}
