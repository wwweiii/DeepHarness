import postgres from 'postgres'

const migrations = [
  {
    version: '0001_phase_1',
    url: new URL('../migrations/0001_phase_1.sql', import.meta.url),
  },
  {
    version: '0002_phase_2',
    url: new URL('../migrations/0002_phase_2.sql', import.meta.url),
  },
  {
    version: '0003_phase_3',
    url: new URL('../migrations/0003_phase_3.sql', import.meta.url),
  },
  {
    version: '0004_phase_4',
    url: new URL('../migrations/0004_phase_4.sql', import.meta.url),
  },
  {
    version: '0005_phase_5',
    url: new URL('../migrations/0005_phase_5.sql', import.meta.url),
  },
  {
    version: '0006_phase_6',
    url: new URL('../migrations/0006_phase_6.sql', import.meta.url),
  },
] as const

export type Database = ReturnType<typeof postgres>

export function createDatabase(url: string): Database {
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })
}

export async function migrate(database: Database): Promise<void> {
  await database.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  for (const migration of migrations) {
    const prior = await database<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${migration.version}
    `
    if (prior.length > 0) continue

    const sql = await Bun.file(migration.url).text()
    await database.begin(async transaction => {
      await transaction.unsafe(sql)
      await transaction`
        INSERT INTO schema_migrations (version) VALUES (${migration.version})
        ON CONFLICT (version) DO NOTHING
      `
    })
  }
}
