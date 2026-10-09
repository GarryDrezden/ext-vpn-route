import { REFRESH_ALARM_NAME, REFRESH_ALARM_PERIOD_MINUTES } from "./config.js";

function runtimeError(chromeApi) {
  const error = chromeApi.runtime && chromeApi.runtime.lastError;
  return error ? new Error(error.message || String(error)) : null;
}

export function isRefreshAlarm(alarm) {
  return Boolean(alarm && alarm.name === REFRESH_ALARM_NAME);
}

/** Idempotent: creates the repeating refresh alarm only when missing or misconfigured. */
export function ensureRefreshAlarm(chromeApi) {
  const alarms = chromeApi.alarms;
  if (!alarms || typeof alarms.get !== "function" || typeof alarms.create !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    alarms.get(REFRESH_ALARM_NAME, (existing) => {
      const getError = runtimeError(chromeApi);
      if (getError) {
        reject(getError);
        return;
      }
      if (existing && existing.periodInMinutes === REFRESH_ALARM_PERIOD_MINUTES) {
        resolve();
        return;
      }
      alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_ALARM_PERIOD_MINUTES }, () => {
        const createError = runtimeError(chromeApi);
        if (createError) reject(createError);
        else resolve();
      });
    });
  });
}

export function wireRefreshAlarmListener(chromeApi, coordinator, report) {
  const alarms = chromeApi.alarms;
  if (!alarms || !alarms.onAlarm || typeof alarms.onAlarm.addListener !== "function") return;
  alarms.onAlarm.addListener((alarm) => {
    if (!isRefreshAlarm(alarm)) return;
    coordinator.sync("alarm").catch(report("sync on alarm"));
  });
}

/** Service-worker init plus install/startup hooks; alarm state lives in chrome.alarms, not in memory. */
export function installRefreshAlarmHooks(chromeApi, report) {
  const run = () => ensureRefreshAlarm(chromeApi).catch(report("ensure refresh alarm"));
  run();
  if (chromeApi.runtime && chromeApi.runtime.onInstalled) {
    chromeApi.runtime.onInstalled.addListener(() => run());
  }
  if (chromeApi.runtime && chromeApi.runtime.onStartup) {
    chromeApi.runtime.onStartup.addListener(() => run());
  }
}
