import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { devices as devicesTable } from "../../db/schema.js";
import type { HMusicDevice } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";

const defaultCapabilities: HMusicDevice["capabilities"] = {
  supportsPlayUrl: true,
  supportsPauseResume: true,
  supportsSeek: false,
  supportsVolume: true,
  supportsRichStatus: false,
  supportsDeviceNext: false,
};

// 「本机播放」虚拟设备：音频不发小爱音箱，由打开网页的浏览器 <audio> 播放。
// 作为普通设备落库，选默认/切换逻辑全部复用；永远在线。
export const LOCAL_DEVICE_ID = "local-browser";

const localDeviceCapabilities: HMusicDevice["capabilities"] = {
  supportsPlayUrl: true,
  supportsPauseResume: true,
  supportsSeek: true,
  supportsVolume: true,
  supportsRichStatus: false,
  supportsDeviceNext: false,
};

async function ensureLocalDevice(
  rows: Array<{ id: string }>,
): Promise<boolean> {
  if (rows.some((row) => row.id === LOCAL_DEVICE_ID)) return false;
  await db
    .insert(devicesTable)
    .values({
      id: LOCAL_DEVICE_ID,
      name: "本机播放",
      type: "browser",
      isOnline: 1,
      // 还没有任何设备（未登录小米）时直接当默认，开箱即可出声。
      isDefault: rows.length === 0 ? 1 : 0,
      capabilitiesJson: JSON.stringify(localDeviceCapabilities),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing();
  return true;
}

export type UpsertDeviceInput = {
  id: string;
  name: string;
  type?: string;
  ip?: string;
  isOnline?: boolean;
  isDefault?: boolean;
  capabilities?: Partial<HMusicDevice["capabilities"]>;
};

export async function listDevices(): Promise<HMusicDevice[]> {
  let rows = await db.select().from(devicesTable);
  if (await ensureLocalDevice(rows)) {
    rows = await db.select().from(devicesTable);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type ?? undefined,
    ip: row.ip ?? undefined,
    // 虚拟设备不存在“离线”，其它设备按探测结果。
    isOnline: row.id === LOCAL_DEVICE_ID ? true : row.isOnline === 1,
    isDefault: row.isDefault === 1,
    capabilities: parseCapabilities(row.capabilitiesJson),
  }));
}

export async function selectDevice(
  deviceId: string,
): Promise<{ selectedDeviceId: string }> {
  const device = (await listDevices()).find((item) => item.id === deviceId);
  if (!device) {
    throw new AppError(
      "DEVICE_NOT_FOUND",
      "设备不存在或小米账号尚未登录",
      404,
      { deviceId },
    );
  }

  const now = Date.now();
  await db.update(devicesTable).set({ isDefault: 0, updatedAt: now });
  await db
    .update(devicesTable)
    .set({ isDefault: 1, updatedAt: now })
    .where(eq(devicesTable.id, deviceId));
  return { selectedDeviceId: deviceId };
}

export async function probeDevice(
  deviceId: string,
): Promise<HMusicDevice["capabilities"]> {
  const device = (await listDevices()).find((item) => item.id === deviceId);
  if (!device) {
    throw new AppError(
      "DEVICE_NOT_FOUND",
      "设备不存在或小米账号尚未登录",
      404,
      { deviceId },
    );
  }

  return device.capabilities;
}

export async function getSelectedDeviceId(): Promise<string | undefined> {
  const selected = (await listDevices()).find((device) => device.isDefault);
  return selected?.id;
}

export async function upsertDevice(
  input: UpsertDeviceInput,
): Promise<HMusicDevice> {
  const now = Date.now();
  const capabilities = {
    ...defaultCapabilities,
    ...input.capabilities,
  };

  if (input.isDefault) {
    await db.update(devicesTable).set({ isDefault: 0, updatedAt: now });
  }

  await db
    .insert(devicesTable)
    .values({
      id: input.id,
      name: input.name,
      type: input.type,
      ip: input.ip,
      isOnline: input.isOnline ? 1 : 0,
      isDefault: input.isDefault ? 1 : 0,
      capabilitiesJson: JSON.stringify(capabilities),
      lastSeenAt: input.isOnline ? now : undefined,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: devicesTable.id,
      set: {
        name: input.name,
        type: input.type,
        ip: input.ip,
        isOnline: input.isOnline ? 1 : 0,
        isDefault: input.isDefault ? 1 : 0,
        capabilitiesJson: JSON.stringify(capabilities),
        lastSeenAt: input.isOnline ? now : undefined,
        updatedAt: now,
      },
    });

  const device = (await listDevices()).find((item) => item.id === input.id);
  if (!device) {
    throw new AppError("DEVICE_UPSERT_FAILED", "设备保存失败", 500, {
      deviceId: input.id,
    });
  }

  return device;
}

function parseCapabilities(value: string): HMusicDevice["capabilities"] {
  try {
    return {
      ...defaultCapabilities,
      ...(JSON.parse(value) as Partial<HMusicDevice["capabilities"]>),
    };
  } catch {
    return defaultCapabilities;
  }
}
