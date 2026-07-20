import { promises as fs } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  appConfig,
  devices,
  downloads,
  miAccounts,
  miVerificationSessions,
  miWebVerificationSessions,
  playHistory,
  playlistTracks,
  playlists,
  tracks,
  users,
} from "../../db/schema.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";

export async function hasAdminUser(): Promise<boolean> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  return existing.length > 0;
}

export async function setupAdmin(
  username: string,
  password: string,
): Promise<{ id: string; username: string }> {
  if (await hasAdminUser()) {
    throw new AppError("AUTH_ALREADY_SETUP", "管理员账号已初始化", 409);
  }

  const now = Date.now();
  const user = {
    id: nanoid(),
    username,
    passwordHash: await bcrypt.hash(password, 12),
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(users).values(user);
  return { id: user.id, username: user.username };
}

export async function verifyLogin(
  username: string,
  password: string,
): Promise<{ id: string; username: string }> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AppError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }

  return { id: user.id, username: user.username };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ id: string; username: string }> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError("USER_NOT_FOUND", "用户不存在", 404);
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    throw new AppError("INVALID_CREDENTIALS", "当前密码错误", 401);
  }

  await db
    .update(users)
    .set({
      passwordHash: await bcrypt.hash(newPassword, 12),
      updatedAt: Date.now(),
    })
    .where(eq(users.id, userId));

  return { id: user.id, username: user.username };
}

// 账户删除（App Store 合规硬要求）：单管理员模型下，删账户即物理清除全部数据，
// 服务端回到未初始化态（/auth/status initialized=false，客户端回 setup）。
// 校验当前密码防误删/越权。内存播放/队列态的重置由路由层在此之后调用。
export async function deleteAccount(
  userId: string,
  password: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError("USER_NOT_FOUND", "用户不存在", 404);
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AppError("INVALID_CREDENTIALS", "密码错误", 401);
  }

  // 先删已下载文件（尽力而为，单个失败不阻断），再清库。
  await fs
    .rm(path.join(env.dataDir, "music"), { recursive: true, force: true })
    .catch(() => {});

  // 清空全部数据表 + 运行配置/会话快照 kv（app_config 承载 runtime/playback/queue/
  // mi 凭据快照，一并抹掉）。用户表最后删，确保过程中断也不会残留半初始化态。
  db.delete(downloads).run();
  db.delete(playHistory).run();
  db.delete(playlistTracks).run();
  db.delete(playlists).run();
  db.delete(tracks).run();
  db.delete(devices).run();
  db.delete(miWebVerificationSessions).run();
  db.delete(miVerificationSessions).run();
  db.delete(miAccounts).run();
  db.delete(appConfig).run();
  db.delete(users).run();
}
