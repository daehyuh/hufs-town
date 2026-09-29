const rangeOptions = {
  "1h": { seconds: 60 * 60, step: "15s" },
  "6h": { seconds: 6 * 60 * 60, step: "1m" },
  "24h": { seconds: 24 * 60 * 60, step: "5m" },
};
const metricQueries = {
  players: "hufs_world_players_active",
  connections: "hufs_world_connections_active",
  tick: "hufs_world_tick_duration_p95_seconds * 1000",
  queue:
    "100 * hufs_world_command_queue_size / clamp_min(hufs_world_command_queue_capacity, 1)",
  apiRate: 'sum(rate(http_server_requests_seconds_count{job="api"}[5m]))',
  apiErrors:
    '100 * sum(rate(http_server_requests_seconds_count{job="api",status=~"5.."}[5m])) / clamp_min(sum(rate(http_server_requests_seconds_count{job="api"}[5m])), 0.001)',
  heap: '100 * sum(jvm_memory_used_bytes{job=~"api|world",area="heap"}) / clamp_min(sum(jvm_memory_max_bytes{job=~"api|world",area="heap"}), 1)',
  joinQueuePressure:
    "100 * hufs_world_join_queue_size / clamp_min(hufs_world_join_queue_capacity, 1)",
  joinQueueSize: "hufs_world_join_queue_size",
  joinQueueCapacity: "hufs_world_join_queue_capacity",
  joinQueueRejected: "increase(hufs_world_join_queue_rejected_total[5m])",
  mediaPeers: "hufs_media_active_peers",
  mediaProducers: "sum(hufs_media_active_producers)",
  mediaConsumers: "sum(hufs_media_active_consumers)",
  recordingSessions: "hufs_media_active_recordings",
  recordingCapacity: "hufs_media_recording_capacity",
  transcriptionJobs: "hufs_media_transcription_jobs_active",
};
const rangeQueries = {
  tick: "hufs_world_tick_duration_p95_seconds * 1000",
  requests: 'sum(rate(http_server_requests_seconds_count{job="api"}[5m]))',
  joinQueuePressure:
    "100 * hufs_world_join_queue_size / clamp_min(hufs_world_join_queue_capacity, 1)",
};
const numberFormat = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 1,
});
let selectedRange = "1h";
let refreshActive = false;

async function promQuery(query, range) {
  const url = new URL(
    `/api/v1/query${range ? "_range" : ""}`,
    window.location.origin,
  );
  url.searchParams.set("query", query);
  if (range) {
    const end = Math.floor(Date.now() / 1000);
    url.searchParams.set("end", String(end));
    url.searchParams.set("start", String(end - range.seconds));
    url.searchParams.set("step", range.step);
  }
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== "success") throw new Error("Prometheus query failed");
  return body.data.result;
}

function scalarValue(result) {
  if (!result?.length || !result[0]?.value) return null;
  const value = Number(result[0].value[1]);
  return Number.isFinite(value) ? value : null;
}

function setValue(id, value, suffix = "", decimals = 0) {
  const node = document.getElementById(id);
  node.textContent =
    value === null
      ? "—"
      : `${numberFormat.format(Number(value.toFixed(decimals)))}${suffix}`;
}

function setTarget(id, value) {
  const node = document.getElementById(id);
  const isUp = value === 1;
  node.dataset.state = value === null ? "unknown" : isUp ? "up" : "down";
  node.textContent =
    value === null ? "수집 대기" : isUp ? "정상 수집" : "응답 없음";
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, String(value));
  return node;
}

function drawChart(id, result, label, color) {
  const container = document.getElementById(id);
  const points = result?.[0]?.values
    ?.map(([time, raw]) => ({ time: Number(time), value: Number(raw) }))
    .filter(
      (point) => Number.isFinite(point.time) && Number.isFinite(point.value),
    );
  if (!points?.length) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "표시할 지표가 아직 없습니다.";
    container.replaceChildren(empty);
    return;
  }

  const width = 760;
  const height = 210;
  const pad = { left: 46, right: 12, top: 14, bottom: 28 };
  const max = Math.max(...points.map((point) => point.value), 0.01);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": label,
  });
  const title = svgElement("title");
  title.textContent = label;
  svg.append(title);

  for (let index = 0; index <= 3; index += 1) {
    const y = pad.top + (plotHeight * index) / 3;
    const value = max * (1 - index / 3);
    const line = svgElement("line", {
      x1: pad.left,
      x2: width - pad.right,
      y1: y,
      y2: y,
      class: "chart-gridline",
    });
    const text = svgElement("text", {
      x: pad.left - 8,
      y: y + 4,
      "text-anchor": "end",
      class: "chart-label",
    });
    text.textContent = numberFormat.format(value);
    svg.append(line, text);
  }

  const coordinates = points.map((point, index) => {
    const x =
      pad.left +
      (points.length < 2
        ? plotWidth / 2
        : (plotWidth * index) / (points.length - 1));
    const y = pad.top + plotHeight * (1 - point.value / max);
    return [x, y];
  });
  const path = coordinates
    .map(
      ([x, y], index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
    )
    .join(" ");
  const fill = svgElement("path", {
    d: `${path} L${coordinates.at(-1)[0].toFixed(1)},${(pad.top + plotHeight).toFixed(1)} L${coordinates[0][0].toFixed(1)},${(pad.top + plotHeight).toFixed(1)} Z`,
    class: "chart-fill",
  });
  const defs = svgElement("defs");
  const gradient = svgElement("linearGradient", {
    id: `gradient-${id}`,
    x1: "0",
    x2: "0",
    y1: "0",
    y2: "1",
  });
  gradient.append(
    svgElement("stop", { offset: "0%", "stop-color": color }),
    svgElement("stop", {
      offset: "100%",
      "stop-color": color,
      "stop-opacity": "0",
    }),
  );
  defs.append(gradient);
  fill.setAttribute("fill", `url(#gradient-${id})`);
  const stroke = svgElement("path", {
    d: path,
    class: "chart-line",
    stroke: color,
  });
  svg.append(defs, fill, stroke);
  container.replaceChildren(svg);
}

async function refresh() {
  if (refreshActive || document.visibilityState === "hidden") return;
  refreshActive = true;
  const status = document.getElementById("refresh-status");
  const notice = document.getElementById("data-notice");
  status.textContent = "갱신 중…";
  const range = rangeOptions[selectedRange];
  const tasks = [
    promQuery('up{job=~"api|world|media"}'),
    ...Object.values(metricQueries).map((query) => promQuery(query)),
    promQuery(rangeQueries.tick, range),
    promQuery(rangeQueries.requests, range),
    promQuery(rangeQueries.joinQueuePressure, range),
  ];
  const results = await Promise.allSettled(tasks);
  const failed = results.filter(
    (result) => result.status === "rejected",
  ).length;
  const valueAt = (index) =>
    results[index]?.status === "fulfilled"
      ? scalarValue(results[index].value)
      : null;
  const targets = results[0]?.status === "fulfilled" ? results[0].value : [];
  const targetUp = (job) => {
    const sample = targets.find((item) => item.metric?.job === job);
    if (!sample?.value) return null;
    const value = Number(sample.value[1]);
    return Number.isFinite(value) ? value : null;
  };

  setTarget("api-target", targetUp("api"));
  setTarget("world-target", targetUp("world"));
  setTarget("media-target", targetUp("media"));
  const queryResult = (key) => {
    const index = Object.keys(metricQueries).indexOf(key) + 1;
    return results[index]?.status === "fulfilled" ? scalarValue(results[index].value) : null;
  };
  setValue("players", valueAt(1));
  setValue("connections", valueAt(2));
  setValue("tick-p95", valueAt(3), " ms", 2);
  setValue("queue-pressure", valueAt(4), "%", 1);
  setValue("api-rate", valueAt(5), " req/s", 2);
  setValue("api-errors", valueAt(6), "%", 2);
  setValue("heap-usage", valueAt(7), "%", 1);
  setValue("join-queue-pressure", valueAt(8), "%", 1);
  setValue("join-queue-size", valueAt(9));
  setValue("join-queue-capacity", valueAt(10));
  setValue("join-queue-rejected", valueAt(11));
  setValue("media-peers", queryResult("mediaPeers"));
  setValue("media-producers", queryResult("mediaProducers"));
  setValue("media-consumers", queryResult("mediaConsumers"));
  setValue("recording-sessions", queryResult("recordingSessions"));
  setValue("recording-capacity", queryResult("recordingCapacity"));
  setValue("transcription-jobs", queryResult("transcriptionJobs"));
  const rangeStart = 1 + Object.keys(metricQueries).length;
  drawChart(
    "tick-chart",
    results[rangeStart]?.status === "fulfilled" ? results[rangeStart].value : [],
    "월드 tick p95, milliseconds",
    "#218055",
  );
  drawChart(
    "request-chart",
    results[rangeStart + 1]?.status === "fulfilled" ? results[rangeStart + 1].value : [],
    "API 요청, requests per second",
    "#bd7d2d",
  );
  drawChart(
    "join-queue-chart",
    results[rangeStart + 2]?.status === "fulfilled" ? results[rangeStart + 2].value : [],
    "월드 입장 대기 큐 사용률, percent",
    "#bd7d2d",
  );

  notice.hidden = failed === 0;
  notice.textContent =
    failed === 0
      ? ""
      : `일부 지표를 가져오지 못했어요 (${failed}개). 수집 대상 상태와 Prometheus 로그를 확인하세요.`;
  status.textContent = `마지막 갱신 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
  refreshActive = false;
}

for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click", () => {
    selectedRange = button.dataset.range;
    for (const option of document.querySelectorAll("[data-range]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    void refresh();
  });
}

void refresh();
window.setInterval(() => void refresh(), 15_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
