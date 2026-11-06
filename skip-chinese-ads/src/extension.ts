import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import type { Point, Rect } from "@swipt/api";
import * as input from "@swipt/api/input";
import * as screen from "@swipt/api/screen";
import type { ScreenMatch } from "@swipt/api/screen";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

import {
  closeRules,
  rules,
  sdkCloseRules,
  sdkRules,
  type Close,
  type Rule,
} from "./rules";
import {
  appendRecord,
  readControls,
  readSettings,
  recordedApps,
  writeControls,
} from "./storage";

const rewarded: Rule = { within: { class: /Reward|Incentive/i } };
const ownApps = /^(?:com\.apple\.|io\.nekohasekai\.swipt(?:\.|$))/;
// 12306: use verified accessibility controls when the display stream stalls.
const noRecordingApps = new Set([
  "com.unionpay.chsp",
  "com.uniqlo.cn",
  "cn.12306.rails12306",
]);
const adWindowMs = 5_000;
const skipText = /跳过/;
const repeatWindowMs = 800;
const repeatDistance = 40;
const freshFrameMs = 400;
const tapVanishMs = 1_000;
const learnVanishMs = 10_000;
const vanishPollMs = 150;
const minimumTextHeight = 10;
const textLanguages = ["zh-Hans"];
const skipCorner = { width: 150, height: 180 };
const controlMargin = 20;
const settleDistance = 4;
const treeMargin = 8;
const controlLimit = 4;
const popupWindowMs = 5_000;
const closeSize = 80;
const largeCloseSize = { width: 240, height: 80 };
const closeVanishMs = 1_500;
const closeLimit = 3;
const closeAttempts = 2;
const swipeMs = 250;

export interface SupportedApp {
  bundleId: string;
  name: string;
  version?: string;
  icon: string;
}

export interface RecordedApp {
  bundleId: string;
  name: string;
  icon?: string;
}

const describe = (element: AccessibilityElement) =>
  `${element.class ?? element.role}@[${element.frame?.map(Math.round) ?? "no frame"}]`;

const centerOf = ([x, y, width, height]: Rect): Point => [
  x + width / 2,
  y + height / 2,
];

const distance = ([ax, ay]: Point, [bx, by]: Point) =>
  Math.hypot(ax - bx, ay - by);

const within = ([ox, oy, ow, oh]: Rect, [x, y, width, height]: Rect) =>
  x >= ox && y >= oy && x + width <= ox + ow && y + height <= oy + oh;

const contains = ([x, y, width, height]: Rect, [px, py]: Point) =>
  px >= x && px <= x + width && py >= y && py <= y + height;

const skipAds = async (
  app: string,
  pid: number,
  since: number,
  closePopups: boolean,
  screenSize: { width: number; height: number },
  shown: Promise<number>,
  signal: AbortSignal,
) => {
  const started = Date.now();
  const stamp = () => `${app} pid ${pid} +${Date.now() - started}ms:`;
  const fuzzy = !Object.hasOwn(rules, app);
  const selectors = (fuzzy ? sdkRules : rules[app].flat()).map((rule) => ({
    ...rule,
    app,
    not: rewarded,
  }));
  const closes: Close[] = (
    !closePopups
      ? []
      : Object.hasOwn(closeRules, app)
        ? closeRules[app].flat()
        : fuzzy
          ? sdkCloseRules
          : []
  ).map((rule) => ({ ...rule, app, not: rewarded }));
  const known = await readControls(app);
  const quick = known.length > 0;
  let lastTap: { at: number; point: Point } | undefined;

  const around = (
    [x, y, width, height]: Rect,
    margin = controlMargin,
  ): Rect => {
    const left = Math.max(0, x - margin);
    const top = Math.max(0, y - margin);
    return [
      left,
      top,
      Math.min(screenSize.width, x + width + margin) - left,
      Math.min(screenSize.height, y + height + margin) - top,
    ];
  };

  const watching = new AbortController();
  const watchSignal = AbortSignal.any([signal, watching.signal]);
  const textOptions = {
    languages: textLanguages,
    minimumHeight: minimumTextHeight,
    signal: watchSignal,
  };

  const vanished = async (frame: Rect, within: number) => {
    const deadline = Date.now() + within;
    const region = around(frame);
    while ((await screen.find(skipText, { region, ...textOptions })) !== null) {
      if (Date.now() >= deadline || signal.aborted) {
        return false;
      }
      await sleep(vanishPollMs, { signal });
    }
    return true;
  };

  const remember = async (
    frame: Rect,
    control: string | undefined,
    how: string,
  ) => {
    const same = known.find(
      (learned) =>
        distance(centerOf(learned.frame), centerOf(frame)) < repeatDistance,
    );
    if (same === undefined) {
      if (known.length >= controlLimit) {
        return;
      }
      known.push({ frame, class: control });
      console.debug(`${stamp()} learned ${how} at [${frame.map(Math.round)}]`);
    } else if (control === undefined || same.class !== undefined) {
      return;
    } else {
      same.class = control;
      console.debug(`${stamp()} ${how} is the learned control`);
    }
    await writeControls(app, known);
  };

  const watchScreen = async (region: Rect) => {
    while (!watchSignal.aborted) {
      const remaining = adWindowMs - (Date.now() - started);
      if (remaining <= 0) {
        return;
      }
      const match = await screen.find(skipText, {
        region,
        timeoutMs: remaining,
        ...textOptions,
      });
      if (match === null) {
        return;
      }
      const detected = Date.now();
      const age =
        match.image.timestamp === null ? 0 : detected - match.image.timestamp;
      const how = `"${match.text}"`;
      console.debug(
        `${stamp()} screen shows ${how} at [${match.center.map(Math.round)}], frame from ${Math.round(age)}ms ago`,
      );
      let frame = match.frame;
      if (age > freshFrameMs) {
        const still = await screen.find(skipText, { region, ...textOptions });
        if (still === null) {
          console.debug(`${stamp()} ${how} is gone`);
          continue;
        }
        frame = still.frame;
      }
      const point = centerOf(frame);
      if (
        lastTap !== undefined &&
        distance(point, lastTap.point) < repeatDistance &&
        Date.now() - lastTap.at < repeatWindowMs
      ) {
        await sleep(repeatWindowMs - (Date.now() - lastTap.at), { signal });
        continue;
      }
      const tapping = Date.now();
      lastTap = { at: tapping, point };
      await input.tap(point, { signal });
      const tapMs = Date.now() - tapping;
      console.debug(
        `${stamp()} tapped [${point.map(Math.round)}] for ${how} in ${tapMs}ms`,
      );
      const deadline = Date.now() + tapVanishMs;
      let still: ScreenMatch | null;
      while (
        (still = await screen.find(skipText, { region, ...textOptions })) !==
          null &&
        distance(still.center, point) < settleDistance
      ) {
        if (Date.now() >= deadline || signal.aborted) {
          break;
        }
        await sleep(vanishPollMs, { signal });
      }
      if (still === null) {
        const gone = Date.now();
        watching.abort();
        await remember(frame, undefined, how);
        await appendRecord({
          time: tapping,
          app,
          fuzzy,
          quick,
          ms: tapping - since,
          text: match.text ?? "",
          kind: "skip",
          appeared:
            match.image.timestamp === null
              ? undefined
              : match.image.timestamp - since,
          detected: detected - since,
          tapMs,
          gone: gone - since,
        });
      } else if (distance(still.center, point) < settleDistance) {
        console.debug(`${stamp()} ${how} is still there after the tap`);
      } else {
        console.debug(
          `${stamp()} ${how} moved to [${still.center.map(Math.round)}] after the tap`,
        );
        lastTap = undefined;
      }
    }
  };

  const watchTree = async () => {
    let seen: string | undefined;
    while (!watchSignal.aborted) {
      const remaining = adWindowMs - (Date.now() - started);
      if (remaining <= 0) {
        return;
      }
      const asked = Date.now();
      const found = await accessibility.find(selectors, {
        timeoutMs: remaining,
        poll: true,
        pollTimeoutMs: adWindowMs,
        signal: watchSignal,
      });
      const waited = Date.now() - asked;
      if (found === null) {
        return;
      }
      const control = describe(found);
      if (found.frame === undefined) {
        console.debug(
          `${stamp()} ${control} has no position, found after ${waited}ms`,
        );
        continue;
      }
      if (control === seen) {
        console.debug(
          `${stamp()} ${control} is still there, read in ${waited}ms`,
        );
        continue;
      }
      console.debug(`${stamp()} tree shows ${control} after ${waited}ms`);
      seen = control;
      const name = found.class ?? found.role;
      const visible = await screen.find(skipText, {
        region: around(found.frame, treeMargin),
        ...textOptions,
      });
      if (visible === null) {
        const learned = known.find((entry) =>
          contains(found.frame!, centerOf(entry.frame)),
        );
        if (learned === undefined) {
          console.debug(`${stamp()} ${control} shows no skip text`);
        } else {
          await remember(learned.frame, name, control);
        }
        continue;
      }
      if (await vanished(visible.frame, learnVanishMs)) {
        watching.abort();
        await remember(visible.frame, name, control);
      } else {
        console.debug(`${stamp()} ${control} stayed on screen, not learned`);
      }
    }
  };

  const watchSdk = async () => {
    while (!watchSignal.aborted) {
      const remaining = adWindowMs - (Date.now() - started);
      if (remaining <= 0) {
        return;
      }
      const found = await accessibility.find(selectors, {
        timeoutMs: remaining,
        poll: true,
        pollTimeoutMs: adWindowMs,
        signal: watchSignal,
      });
      if (found === null) {
        return;
      }
      const detected = Date.now();
      const control = describe(found);
      if (found.frame === undefined) {
        console.debug(`${stamp()} ${control} has no position`);
        await sleep(repeatWindowMs, { signal: watchSignal });
        continue;
      }
      const point = centerOf(found.frame);
      if (
        lastTap !== undefined &&
        distance(point, lastTap.point) < repeatDistance &&
        Date.now() - lastTap.at < repeatWindowMs
      ) {
        await sleep(repeatWindowMs - (Date.now() - lastTap.at), {
          signal: watchSignal,
        });
        continue;
      }
      const tapping = Date.now();
      try {
        await accessibility.tap(found, {
          timeoutMs: remaining,
          signal: watchSignal,
        });
      } catch (error) {
        if ((error as Error).name !== "TimeoutError") {
          throw error;
        }
        console.debug(
          `${stamp()} ${control} cannot be tapped: ${(error as Error).message}`,
        );
        continue;
      }
      lastTap = { at: tapping, point };
      const tapMs = Date.now() - tapping;
      console.debug(`${stamp()} tapped ${control} in ${tapMs}ms`);
      const deadline = Date.now() + closeVanishMs;
      let still: AccessibilityElement | null;
      while (
        (still = await accessibility.find(selectors, {
          signal: watchSignal,
        })) !== null
      ) {
        if (Date.now() >= deadline) {
          break;
        }
        await sleep(vanishPollMs, { signal: watchSignal });
      }
      if (still !== null) {
        console.debug(`${stamp()} ${control} is still there after the tap`);
        continue;
      }
      const gone = Date.now();
      watching.abort();
      await remember(found.frame, found.class ?? found.role, control);
      await appendRecord({
        time: tapping,
        app,
        fuzzy,
        quick: false,
        ms: tapping - since,
        text: found.label ?? found.class ?? "",
        kind: "skip",
        detected: detected - since,
        tapMs,
        gone: gone - since,
      });
    }
  };

  const watchPopups = async (shownAt: number, candidates: Close[]) => {
    const swipe = candidates[0]?.swipe;
    const large = candidates[0]?.large === true;
    const selectors = candidates.map(
      ({ swipe: _, large: __, ...rule }) => rule,
    );
    const attempts = new Map<string, number>();
    let closed = 0;
    let last: { control: string; at: number } | undefined;
    while (!signal.aborted && closed < closeLimit) {
      const remaining = popupWindowMs - (Date.now() - shownAt);
      if (remaining <= 0) {
        return;
      }
      const found = await accessibility.find(selectors, {
        timeoutMs: remaining,
        signal,
      });
      if (found === null) {
        return;
      }
      const detected = Date.now();
      const control = describe(found);
      if (
        found.frame === undefined ||
        (last?.control === control && Date.now() - last.at < repeatWindowMs)
      ) {
        await sleep(repeatWindowMs, { signal });
        continue;
      }
      if ((attempts.get(control) ?? 0) >= closeAttempts) {
        console.debug(
          `${stamp()} popup control ${control} resisted ${closeAttempts} attempts, giving up`,
        );
        return;
      }
      attempts.set(control, (attempts.get(control) ?? 0) + 1);
      last = { control, at: Date.now() };
      const [x, y, width, height] = found.frame;
      const limit = large
        ? largeCloseSize
        : { width: closeSize, height: closeSize };
      if (
        swipe === undefined &&
        (width > limit.width || height > limit.height)
      ) {
        console.debug(
          `${stamp()} popup control ${control} is too large to tap`,
        );
        await sleep(repeatWindowMs, { signal });
        continue;
      }
      const point = centerOf(found.frame);
      const acting = Date.now();
      if (swipe === undefined) {
        await input.tap(point, { signal });
      } else {
        const target: Point =
          swipe === "left"
            ? [Math.max(0, x - width), point[1]]
            : swipe === "right"
              ? [Math.min(screenSize.width - 1, x + width * 2), point[1]]
              : swipe === "up"
                ? [point[0], Math.max(0, y - height)]
                : [point[0], Math.min(screenSize.height - 1, y + height * 2)];
        await input.swipe(point, target, { durationMs: swipeMs, signal });
      }
      const tapMs = Date.now() - acting;
      console.debug(
        `${stamp()} ${swipe === undefined ? "tapped" : `swiped ${swipe}`} popup control ${control} at [${point.map(Math.round)}]`,
      );
      const deadline = Date.now() + closeVanishMs;
      let still: AccessibilityElement | null;
      while (
        (still = await accessibility.find(selectors, { signal })) !== null &&
        describe(still) === control
      ) {
        if (Date.now() >= deadline || signal.aborted) {
          break;
        }
        await sleep(vanishPollMs, { signal });
      }
      if (still !== null && describe(still) === control) {
        console.debug(`${stamp()} popup control ${control} is still there`);
        continue;
      }
      closed++;
      await appendRecord({
        time: acting,
        app,
        fuzzy,
        quick: false,
        ms: acting - since,
        text: found.label ?? found.class ?? "",
        kind: "close",
        detected: detected - since,
        tapMs,
        gone: Date.now() - since,
      });
    }
  };

  const watchPopupsResilient = async (shownAt: number) => {
    const groups = new Map<string, Close[]>();
    for (const rule of closes) {
      const key = `${rule.swipe ?? ""}/${rule.large === true}`;
      groups.set(key, [...(groups.get(key) ?? []), rule]);
    }
    await Promise.all(
      [...groups.values()].map(async (candidates) => {
        while (!signal.aborted) {
          try {
            await watchPopups(shownAt, candidates);
            return;
          } catch (error) {
            if (
              (error as Error).name !== "UnavailableError" ||
              Date.now() - shownAt > popupWindowMs
            ) {
              throw error;
            }
            console.warn(`${stamp()} the tree is unavailable, retrying`, error);
            await sleep(300, { signal });
          }
        }
      }),
    );
  };

  const resilient = async (watch: () => Promise<void>) => {
    while (!signal.aborted) {
      try {
        await watch();
        return;
      } catch (error) {
        if (
          (error as Error).name !== "UnavailableError" ||
          Date.now() - started > adWindowMs
        ) {
          throw error;
        }
        console.warn(`${stamp()} the tree is unavailable, retrying`, error);
        await sleep(300, { signal });
      }
    }
  };

  const corners: Rect[] = [
    [
      screenSize.width - skipCorner.width,
      0,
      skipCorner.width,
      skipCorner.height,
    ],
    [
      screenSize.width - skipCorner.width,
      screenSize.height - skipCorner.height,
      skipCorner.width,
      skipCorner.height,
    ],
  ];
  const regions = [
    ...corners,
    ...known
      .map((control) => around(control.frame))
      .filter((region) => !corners.some((corner) => within(corner, region))),
  ];
  console.debug(`${stamp()} round started with ${known.length} controls`);
  try {
    const shownAt = await shown;
    const watchers = noRecordingApps.has(app)
      ? [resilient(watchSdk)]
      : fuzzy
        ? [
            ...known.map((control) => watchScreen(around(control.frame))),
            resilient(watchSdk),
          ]
        : [
            ...regions.map(watchScreen),
            ...(known.length === 0 ? [resilient(watchTree)] : []),
          ];
    await Promise.all([
      ...watchers.map((watcher) =>
        watcher.catch((error: Error) => {
          if (error.name !== "AbortError") {
            console.warn(`${stamp()} watching for the ad failed`, error);
          }
        }),
      ),
      ...(closes.length > 0 ? [watchPopupsResilient(shownAt)] : []),
    ]);
  } finally {
    console.debug(`${stamp()} round ended`);
  }
};

export default defineExtension({
  async run({ signal }) {
    const { screen: screenSize } = await device.info({ signal });
    const rounds = new Map<
      string,
      {
        pid: number;
        controller: AbortController;
        shown: (time: number) => void;
      }
    >();
    for await (const event of device.applicationEvents({ signal })) {
      if (ownApps.test(event.bundleId)) {
        continue;
      }
      console.debug(
        `${event.bundleId} pid ${event.pid}: ${event.type}, delivered ${Date.now() - event.time}ms after the event`,
      );
      const running = rounds.get(event.bundleId);
      if (event.type === "background") {
        if (running?.pid === event.pid) {
          running.controller.abort();
          rounds.delete(event.bundleId);
        }
        continue;
      }
      if (running?.pid === event.pid) {
        if (event.type === "foreground") {
          running.shown(event.time);
        }
        continue;
      }
      const settings = await readSettings();
      if (
        settings.disabledApps.includes(event.bundleId) ||
        (!settings.fuzzySkip && !Object.hasOwn(rules, event.bundleId))
      ) {
        continue;
      }
      running?.controller.abort();
      const controller = new AbortController();
      let shown!: (time: number) => void;
      const onScreen = new Promise<number>((resolve) => {
        shown = resolve;
      });
      if (event.type === "foreground") {
        shown(event.time);
      }
      rounds.set(event.bundleId, { pid: event.pid, controller, shown });
      skipAds(
        event.bundleId,
        event.pid,
        event.time,
        settings.closePopups,
        screenSize,
        onScreen,
        AbortSignal.any([signal, controller.signal]),
      ).catch((error: Error) => {
        if (error.name !== "AbortError") {
          console.error(event.bundleId, error);
        }
      });
    }
  },
  actions: {
    supportedApps: defineAction({
      title: "List Supported Apps",
      async run(_, { signal }) {
        const installed = (
          await device.installedApplications({ signal })
        ).filter((app) => Object.hasOwn(rules, app.bundleId));
        const apps: SupportedApp[] = await Promise.all(
          installed.map(async ({ bundleId, name, version }) => ({
            bundleId,
            name,
            version,
            icon: (await device.applicationIcon(bundleId, { signal })).uri,
          })),
        );
        apps.sort((first, second) => first.name.localeCompare(second.name));
        return apps;
      },
    }),
    recordedApps: defineAction({
      title: "List Recorded Apps",
      async run(_, { signal }) {
        const installed = await device.installedApplications({ signal });
        return Promise.all(
          (await recordedApps()).map(async (bundleId): Promise<RecordedApp> => {
            const app = installed.find((it) => it.bundleId === bundleId);
            return {
              bundleId,
              name: app?.name ?? bundleId,
              icon:
                app === undefined
                  ? undefined
                  : (await device.applicationIcon(bundleId, { signal })).uri,
            };
          }),
        );
      },
    }),
  },
});
