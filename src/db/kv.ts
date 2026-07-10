import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { appConfig } from "./schema.js";

// 轻量 KV：复用 app_config 表存运行时快照（播放状态/队列等），
// 让服务重启后能恢复"正在放什么"，而不是全部归零。

export function kvGet<T>(key: string): T | undefined {
  const rows = db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .limit(1)
    .all();
  if (!rows[0]) return undefined;
  try {
    return JSON.parse(rows[0].valueJson) as T;
  } catch {
    return undefined;
  }
}

export function kvSet(key: string, value: unknown): void {
  const now = Date.now();
  const valueJson = JSON.stringify(value);
  db.insert(appConfig)
    .values({ key, valueJson, updatedAt: now })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { valueJson, updatedAt: now },
    })
    .run();
}
