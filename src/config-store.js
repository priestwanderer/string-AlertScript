import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { normalizeMonitorConfig, parseMonitorConfig } from './logic.js';

export const CONFIG_FILE = new URL('../data/monitor-config.json', import.meta.url);

export function toStoredConfig(config) {
  return {
    webhookUrl: config.webhookUrl,
    quotaRemainPercent: config.quotaRemainPercent,
    cooldownMinutes: config.cooldownMinutes,
    pageSize: config.pageSize,
    timeoutMs: config.timeoutMs,
    checkIntervalMinutes: config.checkIntervalMinutes,
    servers: config.servers.map((server) => ({
      id: server.id,
      name: server.name,
      baseUrl: server.baseUrl,
      email: server.email,
      password: server.password,
      enabled: server.enabled,
      monitorAllAccounts: server.monitorAllAccounts,
      estimatedCostThreshold: server.estimatedCostThreshold,
      groupScope: server.groupScope,
      groups: server.groups.map((group) => ({
        id: group.id,
        name: group.name
      }))
    }))
  };
}

export async function loadMonitorConfig(env = process.env) {
  try {
    const text = await readFile(CONFIG_FILE, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('data/monitor-config.json 不是有效 JSON');
    }
    return normalizeMonitorConfig(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return parseMonitorConfig(env);
}

export async function saveMonitorConfig(input) {
  const config = normalizeMonitorConfig(input);
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(toStoredConfig(config), null, 2)}\n`, 'utf8');
  return config;
}
