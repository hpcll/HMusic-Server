import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
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
