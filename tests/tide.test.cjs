const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).filter(source => source.trim());
const appScript = scripts.find(source => source.includes('const STATIONS'));
// Run the actual model functions without loading the DOM or CDN libraries.
const modelSource = appScript.slice(0, appScript.indexOf('    let currentStation'));
const context = vm.createContext({});
vm.runInContext(modelSource, context);
const model = vm.runInContext('({ STATIONS, getLunarDay, calculateTideEvents, generateCurveData, formatDateInput, getKstNow })', context);

test('all inline JavaScript parses', () => {
  assert.equal(scripts.length, 2);
  for (const source of scripts) new vm.Script(source);
});

test('all 41 locations have unique IDs and valid demo parameters', () => {
  const stations = model.STATIONS;
  assert.equal(stations.length, 41);
  assert.equal(new Set(stations.map(station => station.id)).size, stations.length);
  const counts = { west: 0, south: 0, east: 0, jeju: 0 };
  for (const station of stations) {
    assert.ok(station.region in counts);
    counts[station.region]++;
    assert.ok(station.name && station.en);
    assert.ok(Number.isFinite(station.maxTide) && station.maxTide > station.minTide);
    assert.ok(station.minTide >= 0);
  }
  assert.deepEqual(counts, { west: 12, south: 11, east: 12, jeju: 6 });
});

const dates = ['2024-01-01', '2024-01-11', '2024-02-29', '2026-10-15', '2030-12-31'];

test('lunar approximation stays in range, including dates before its epoch', () => {
  for (const dateString of dates) {
    const result = model.getLunarDay(new Date(`${dateString}T00:00:00`));
    assert.ok(result.lunarDay >= 1 && result.lunarDay <= 30, dateString);
    assert.ok(result.lunarAge >= 0 && result.lunarAge < 29.53058867, dateString);
  }
});

test('every location and boundary date produces ordered events and a finite 48-point curve', () => {
  for (const station of model.STATIONS) {
    for (const dateString of dates) {
      const date = new Date(`${dateString}T00:00:00`);
      const data = model.calculateTideEvents(station, date);
      assert.equal(data.events.length, 4);
      assert.equal(data.events.filter(event => event.isHigh).length, 2);
      assert.ok(data.highVal > data.lowVal);
      data.events.forEach((event, i) => {
        assert.ok(event.timeVal >= 0 && event.timeVal < 24);
        assert.match(event.timeStr, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
        assert.ok(Number.isFinite(event.level));
        if (i) assert.ok(data.events[i - 1].timeVal <= event.timeVal);
      });
      const curve = model.generateCurveData(station, date, data);
      assert.equal(curve.labels.length, 48);
      assert.equal(curve.levels.length, 48);
      assert.equal(curve.labels[0], '0:00');
      assert.equal(curve.labels.at(-1), '23:30');
      assert.ok(curve.levels.every(Number.isFinite));
    }
  }
});

test('date input preserves selected calendar dates', () => {
  for (const dateString of dates) {
    assert.equal(model.formatDateInput(new Date(`${dateString}T00:00:00`)), dateString);
  }
});

test('KST today crosses midnight at 15:00 UTC', () => {
  const before = model.getKstNow(new Date('2026-10-14T14:59:00Z'));
  const after = model.getKstNow(new Date('2026-10-14T15:00:00Z'));
  assert.equal(before.dateString, '2026-10-14');
  assert.equal(before.hour, 23 + 59 / 60);
  assert.equal(after.dateString, '2026-10-15');
  assert.equal(after.hour, 0);
});

test('selected dates and model results are consistent across browser time zones', () => {
  const code = `
    const vm = require('node:vm');
    const context = vm.createContext({});
    vm.runInContext(${JSON.stringify(modelSource)}, context);
    process.stdout.write(vm.runInContext(${JSON.stringify(`JSON.stringify(${JSON.stringify(dates)}.map(value => {
      const date = new Date(value + 'T00:00:00');
      return [formatDateInput(date), getLunarDay(date), calculateTideEvents(STATIONS[0], date).events,
        getKstNow(new Date('2026-10-14T15:00:00Z'))];
    }))`)}, context));
  `;
  const results = ['UTC', 'Asia/Seoul', 'America/Los_Angeles'].map(TZ => {
    const child = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8', env: { ...process.env, TZ }, timeout: 10000
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('documentation local links and preview image exist', () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md'];
  for (const file of files) {
    const fullPath = path.join(root, file);
    const markdown = fs.readFileSync(fullPath, 'utf8');
    for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(fullPath), target)), `${file}: ${target}`);
    }
  }
});
