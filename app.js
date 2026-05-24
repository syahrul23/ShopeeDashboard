(function () {
  "use strict";

  const STORAGE_KEY = "shopeeDashboardSnapshots:v1";
  const CORE_VERSION = "1.0.0";
  const FFMPEG_VERSION = "0.12.15";
  const FFMPEG_CORE_VERSION = "0.12.10";
  const FFMPEG_LOCAL_SCRIPT = "./vendor/ffmpeg/ffmpeg.js";
  const FFMPEG_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
  const VIDEO_SIZE_WARNING_BYTES = 100 * 1024 * 1024;
  const VIDEO_DURATION_WARNING_SECONDS = 180;
  const QUALITY_PRESETS = {
    balanced: { label: "Balanced", crf: "23" },
    small: { label: "Smaller file", crf: "28" },
    high: { label: "Higher quality", crf: "20" }
  };
  const videoState = {
    file: null,
    previewUrl: "",
    outputUrl: "",
    inputName: "",
    outputName: "",
    outputSize: 0,
    metadata: {
      duration: 0,
      width: 0,
      height: 0
    },
    ffmpeg: null,
    ffmpegScript: null,
    loadingEngine: null,
    converting: false
  };

  const ADS_COLUMNS = ["Ad name", "Amount spent (MYR)", "Link clicks"];
  const COMMISSION_COLUMNS = ["Order id", "Affiliate Net Commission(RM)", "Sub_id4"];

  const money = new Intl.NumberFormat("ms-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const num = new Intl.NumberFormat("ms-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

  const decimal = new Intl.NumberFormat("ms-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function cleanHeader(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim();
  }

  function normalizeKey(value) {
    return cleanHeader(value).toLowerCase();
  }

  function parseCsv(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      const next = source[i + 1];

      if (char === "\"") {
        if (inQuotes && next === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
        continue;
      }

      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(field);
        field = "";
        if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
        row = [];
        continue;
      }

      field += char;
    }

    row.push(field);
    if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);

    const headers = (rows.shift() || []).map(cleanHeader);
    const records = rows.map((cells) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] == null ? "" : String(cells[index]).trim();
      });
      return record;
    });

    return { headers, rows: records };
  }

  function hasColumns(headers, required) {
    const lookup = new Set(headers.map(normalizeKey));
    return required.every((column) => lookup.has(normalizeKey(column)));
  }

  function detectFile(parsed) {
    if (hasColumns(parsed.headers, ADS_COLUMNS)) return "ads";
    if (hasColumns(parsed.headers, COMMISSION_COLUMNS)) return "commission";
    return "unknown";
  }

  function getField(row, names) {
    const candidates = Array.isArray(names) ? names : [names];
    const keys = Object.keys(row || {});
    for (const name of candidates) {
      const wanted = normalizeKey(name);
      const match = keys.find((key) => normalizeKey(key) === wanted);
      if (match) return row[match];
    }
    return "";
  }

  function parseNumber(value) {
    if (value == null) return 0;
    const raw = String(value).trim();
    if (!raw || raw === "-") return 0;
    const negative = raw.startsWith("(") && raw.endsWith(")");
    const cleaned = raw.replace(/[(),%A-Za-z\s]/g, "").replace(/RM/g, "");
    const parsed = Number.parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;
    return negative ? -parsed : parsed;
  }

  function safeDivide(a, b) {
    return b ? a / b : 0;
  }

  function normalizeAdNo(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const withoutDecimal = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    const parsed = Number.parseInt(withoutDecimal, 10);
    if (Number.isFinite(parsed) && String(parsed) === withoutDecimal.replace(/^0+/, "") || withoutDecimal === "0") {
      return String(parsed);
    }
    if (/^\d+$/.test(withoutDecimal)) return String(Number.parseInt(withoutDecimal, 10));
    return withoutDecimal;
  }

  function normalizeSubId4(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const withoutDecimal = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    if (!/^\d+$/.test(withoutDecimal)) return "";
    return String(Number.parseInt(withoutDecimal, 10));
  }

  function simpleHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function fingerprintRows(headers, rows) {
    const sortedHeaders = headers.map(cleanHeader).sort((a, b) => a.localeCompare(b));
    const canonicalRows = rows
      .map((row) => sortedHeaders.map((header) => String(row[header] || "").trim()).join("\u001f"))
      .sort();
    return simpleHash(`${sortedHeaders.join("\u001e")}\u001d${canonicalRows.join("\u001c")}`);
  }

  function commissionKey(row) {
    const orderId = String(getField(row, "Order id") || "").trim();
    const itemId = String(getField(row, "Item id") || "").trim();
    const itemName = String(getField(row, "Item Name") || "").trim().toLowerCase().replace(/\s+/g, " ");
    const purchase = parseNumber(getField(row, "Purchase Value(RM)")).toFixed(4);
    const commission = parseNumber(getField(row, "Affiliate Net Commission(RM)")).toFixed(4);
    if (orderId && itemId) return `order-item|${orderId}|${itemId}|${purchase}|${commission}`;
    if (orderId && itemName) return `order-name|${orderId}|${itemName}|${purchase}|${commission}`;
    const conversionId = String(getField(row, "Conversion id") || "").trim();
    if (orderId || conversionId) return `order-conversion|${orderId}|${conversionId}|${purchase}|${commission}`;
    return simpleHash(JSON.stringify(row));
  }

  function commissionRowQuality(row) {
    const keys = Object.keys(row || {});
    const nonEmpty = keys.filter((key) => String(row[key] || "").trim()).length;
    let quality = nonEmpty;
    if (getField(row, "Affiliate Item Status") || getField(row, "Order Status")) quality += 30;
    if (getField(row, "Attribution Type")) quality += 12;
    if (getField(row, "Complete Time")) quality += 8;
    if (getField(row, "Shop id")) quality += 5;
    return quality;
  }

  function duplicateOrderId(row) {
    return String(getField(row, "Order id") || "").trim() || "unknown-order";
  }

  function groupInit() {
    return {
      orders: new Set(),
      items: 0,
      purchaseValue: 0,
      expectedCommission: 0,
      completedCommission: 0,
      pendingCommission: 0,
      completedOrders: new Set(),
      pendingOrders: new Set()
    };
  }

  function addCommissionGroup(group, row, status) {
    const orderId = String(getField(row, "Order id") || "").trim();
    const purchase = parseNumber(getField(row, "Purchase Value(RM)"));
    const commission = parseNumber(getField(row, "Affiliate Net Commission(RM)"));
    group.items += 1;
    group.purchaseValue += purchase;
    group.expectedCommission += commission;
    if (orderId) group.orders.add(orderId);
    if (status === "completed") {
      group.completedCommission += commission;
      if (orderId) group.completedOrders.add(orderId);
    }
    if (status === "pending") {
      group.pendingCommission += commission;
      if (orderId) group.pendingOrders.add(orderId);
    }
  }

  function statusType(row) {
    const status = String(getField(row, ["Affiliate Item Status", "Order Status"]) || "").trim().toLowerCase();
    if (status.includes("cancel")) return "cancelled";
    if (status.includes("complete")) return "completed";
    if (status.includes("pending")) return "pending";
    return status || "unknown";
  }

  function groupBy(rows, keyFn, rowFn) {
    const map = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!key) return;
      if (!map.has(key)) map.set(key, groupInit());
      rowFn(map.get(key), row);
    });
    return map;
  }

  function serializeGroup(key, group, extra = {}) {
    const purchaseValue = group.purchaseValue;
    const expectedCommission = group.expectedCommission;
    return {
      key,
      orders: group.orders.size,
      items: group.items,
      purchaseValue,
      expectedCommission,
      completedCommission: group.completedCommission,
      pendingCommission: group.pendingCommission,
      avgCommissionRate: safeDivide(expectedCommission, purchaseValue),
      ...extra
    };
  }

  function actionForAd(row, totalSpend) {
    if (!row.spend && row.expectedCommission > 0) {
      return { label: "Tracking Only", tone: "tracking", note: "Ada komisyen tetapi tiada Ads row dipadankan." };
    }
    if (row.commissionRoas >= 1 && (row.orders >= 2 || row.linkClicks >= 100)) {
      return { label: "Scale", tone: "scale", note: "ROAS komisyen sudah lepas break-even." };
    }
    if (row.expectedCommission > 0) {
      const highSpend = row.spend >= Math.max(10, totalSpend * 0.1);
      if (row.commissionRoas < 0.2 && highSpend) {
        return { label: "Cut Budget", tone: "cut", note: "Ada komisyen tetapi spend terlalu berat." };
      }
      if (row.commissionRoas >= 0.4) {
        return { label: "Protect/Test More", tone: "protect", note: "Relatif kuat, tambah data sebelum scale." };
      }
      return { label: "Optimize", tone: "optimize", note: "Ada order, tapi belum cukup dekat break-even." };
    }
    if (row.spend >= 5 || row.linkClicks >= 40) {
      return { label: "Pause/Kill", tone: "pause", note: "Spend/klik sudah jalan tanpa komisyen." };
    }
    return { label: "Observe", tone: "observe", note: "Data masih kecil." };
  }

  function buildCasingIssues(rows, field) {
    const variants = new Map();
    rows.forEach((row) => {
      const value = String(getField(row, field) || "").trim();
      if (!value) return;
      const key = value.toLowerCase();
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(value);
    });
    return [...variants.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([key, set]) => ({ field, key, variants: [...set] }));
  }

  function parseDateTime(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const [, year, month, day, hour, minute, second = "0"] = match;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
      return Number.isFinite(date.getTime()) ? date : null;
    }
    const fallback = new Date(raw);
    return Number.isFinite(fallback.getTime()) ? fallback : null;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function buildHoldAnalysis(rows) {
    const orders = new Map();
    let missingTimeRows = 0;
    let invalidTimeOrders = 0;
    const buckets = [
      { key: "0-15 min", maxMs: 15 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "15 min-1 jam", maxMs: 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "1-6 jam", maxMs: 6 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "6-24 jam", maxMs: 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "1-3 hari", maxMs: 3 * 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "3-7 hari", maxMs: 7 * 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "7 hari+", maxMs: Infinity, orders: 0, purchaseValue: 0, expectedCommission: 0 }
    ];

    rows.forEach((row) => {
      const clickTime = parseDateTime(getField(row, "Click Time"));
      const orderTime = parseDateTime(getField(row, "Order Time"));
      if (!clickTime || !orderTime) {
        missingTimeRows += 1;
        return;
      }
      const orderId = String(getField(row, "Order id") || commissionKey(row)).trim();
      const current = orders.get(orderId) || {
        orderId,
        clickTime,
        orderTime,
        purchaseValue: 0,
        expectedCommission: 0,
        items: 0
      };
      if (clickTime.getTime() < current.clickTime.getTime()) current.clickTime = clickTime;
      if (orderTime.getTime() < current.orderTime.getTime()) current.orderTime = orderTime;
      current.purchaseValue += parseNumber(getField(row, "Purchase Value(RM)"));
      current.expectedCommission += parseNumber(getField(row, "Affiliate Net Commission(RM)"));
      current.items += 1;
      orders.set(orderId, current);
    });

    const durations = [];
    const invalidOrders = [];
    const validOrders = [];
    orders.forEach((order) => {
      const holdMs = order.orderTime.getTime() - order.clickTime.getTime();
      if (holdMs < 0) {
        invalidTimeOrders += 1;
        invalidOrders.push(order);
        return;
      }
      durations.push(holdMs);
      validOrders.push({ ...order, holdMs });
      const bucket = buckets.find((item) => holdMs <= item.maxMs) || buckets[buckets.length - 1];
      bucket.orders += 1;
      bucket.purchaseValue += order.purchaseValue;
      bucket.expectedCommission += order.expectedCommission;
    });

    const totalOrders = validOrders.length;
    const totalCommission = validOrders.reduce((sum, order) => sum + order.expectedCommission, 0);
    const totalPurchaseValue = validOrders.reduce((sum, order) => sum + order.purchaseValue, 0);
    const sameHourOrders = validOrders.filter((order) => order.holdMs <= 60 * 60 * 1000).length;
    const sameDayOrders = validOrders.filter((order) => order.holdMs <= 24 * 60 * 60 * 1000).length;
    const delayedOrders = validOrders.filter((order) => order.holdMs > 24 * 60 * 60 * 1000).length;

    return {
      totalOrders,
      missingTimeRows,
      invalidTimeOrders,
      avgMs: safeDivide(durations.reduce((sum, value) => sum + value, 0), durations.length),
      medianMs: median(durations),
      shortestMs: durations.length ? Math.min(...durations) : 0,
      longestMs: durations.length ? Math.max(...durations) : 0,
      sameHourRate: safeDivide(sameHourOrders, totalOrders),
      sameDayRate: safeDivide(sameDayOrders, totalOrders),
      delayedRate: safeDivide(delayedOrders, totalOrders),
      totalPurchaseValue,
      totalCommission,
      buckets: buckets.map((bucket) => ({
        key: bucket.key,
        orders: bucket.orders,
        purchaseValue: bucket.purchaseValue,
        expectedCommission: bucket.expectedCommission,
        rate: safeDivide(bucket.orders, totalOrders),
        commissionShare: safeDivide(bucket.expectedCommission, totalCommission),
        purchaseValueShare: safeDivide(bucket.purchaseValue, totalPurchaseValue)
      })),
      invalidOrders: invalidOrders.map((order) => order.orderId)
    };
  }

  function computeAnalysis(adsRows, commissionRows, meta) {
    const adsByAd = new Map();
    const adsTotals = {
      spend: 0,
      impressions: 0,
      reach: 0,
      linkClicks: 0,
      clicksAll: 0
    };

    adsRows.forEach((row) => {
      const adNo = normalizeAdNo(getField(row, "Ad name")) || "Unknown";
      const current = adsByAd.get(adNo) || {
        adNo,
        spend: 0,
        impressions: 0,
        reach: 0,
        linkClicks: 0,
        clicksAll: 0
      };
      current.spend += parseNumber(getField(row, "Amount spent (MYR)"));
      current.impressions += parseNumber(getField(row, "Impressions"));
      current.reach += parseNumber(getField(row, "Reach"));
      current.linkClicks += parseNumber(getField(row, "Link clicks"));
      current.clicksAll += parseNumber(getField(row, "Clicks (all)"));
      adsByAd.set(adNo, current);
    });

    adsByAd.forEach((row) => {
      adsTotals.spend += row.spend;
      adsTotals.impressions += row.impressions;
      adsTotals.reach += row.reach;
      adsTotals.linkClicks += row.linkClicks;
      adsTotals.clicksAll += row.clicksAll;
    });

    const expectedRows = [];
    const cancelledRows = [];
    const unmappedRows = [];

    commissionRows.forEach((row) => {
      const status = statusType(row);
      if (status === "cancelled") {
        cancelledRows.push(row);
        return;
      }
      expectedRows.push(row);
      const subid = String(getField(row, "Sub_id4") || "").trim();
      if (subid && !normalizeSubId4(subid)) unmappedRows.push(row);
    });

    const totalsGroup = groupInit();
    expectedRows.forEach((row) => addCommissionGroup(totalsGroup, row, statusType(row)));

    const commissionTotals = serializeGroup("Total", totalsGroup, {
      cancelledItems: cancelledRows.length,
      cancelledOrders: new Set(cancelledRows.map((row) => getField(row, "Order id")).filter(Boolean)).size
    });

    const commissionByAd = groupBy(
      expectedRows,
      (row) => normalizeSubId4(getField(row, "Sub_id4")),
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const adKeys = new Set([...adsByAd.keys(), ...commissionByAd.keys()]);
    const perAd = [...adKeys].map((adNo) => {
      const ads = adsByAd.get(adNo) || {
        adNo,
        spend: 0,
        impressions: 0,
        reach: 0,
        linkClicks: 0,
        clicksAll: 0
      };
      const group = commissionByAd.get(adNo) || groupInit();
      const row = {
        adNo,
        spend: ads.spend,
        impressions: ads.impressions,
        reach: ads.reach,
        linkClicks: ads.linkClicks,
        clicksAll: ads.clicksAll,
        ctrLink: safeDivide(ads.linkClicks, ads.impressions),
        cpcLink: safeDivide(ads.spend, ads.linkClicks),
        cpm: safeDivide(ads.spend, ads.impressions) * 1000,
        orders: group.orders.size,
        items: group.items,
        purchaseValue: group.purchaseValue,
        expectedCommission: group.expectedCommission,
        completedCommission: group.completedCommission,
        pendingCommission: group.pendingCommission,
        avgCommissionRate: safeDivide(group.expectedCommission, group.purchaseValue),
        commissionRoas: safeDivide(group.expectedCommission, ads.spend),
        gmvRoas: safeDivide(group.purchaseValue, ads.spend),
        roi: safeDivide(group.expectedCommission - ads.spend, ads.spend),
        epc: safeDivide(group.expectedCommission, ads.linkClicks),
        cpa: safeDivide(ads.spend, group.orders.size),
        orderCvr: safeDivide(group.orders.size, ads.linkClicks)
      };
      row.action = actionForAd(row, adsTotals.spend);
      return row;
    }).sort((a, b) => {
      if (b.commissionRoas !== a.commissionRoas) return b.commissionRoas - a.commissionRoas;
      return b.expectedCommission - a.expectedCommission;
    });

    const attributionMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "Attribution Type") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const categoryMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "L1 Global Category") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const productMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "Item Name") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const audience = new Map();
    adsRows.forEach((row) => {
      const age = String(getField(row, "Age") || "Unknown").trim() || "Unknown";
      const gender = String(getField(row, "Gender") || "Unknown").trim() || "Unknown";
      const key = `${age} | ${gender}`;
      const current = audience.get(key) || { age, gender, spend: 0, impressions: 0, linkClicks: 0 };
      current.spend += parseNumber(getField(row, "Amount spent (MYR)"));
      current.impressions += parseNumber(getField(row, "Impressions"));
      current.linkClicks += parseNumber(getField(row, "Link clicks"));
      audience.set(key, current);
    });

    const attribution = [...attributionMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission);

    const categories = [...categoryMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission);

    const products = [...productMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission)
      .slice(0, 12);

    const audienceRows = [...audience.values()]
      .map((row) => ({
        ...row,
        ctr: safeDivide(row.linkClicks, row.impressions),
        cpc: safeDivide(row.spend, row.linkClicks)
      }))
      .sort((a, b) => b.spend - a.spend);

    const hold = buildHoldAnalysis(expectedRows);

    const expectedCommission = commissionTotals.expectedCommission;
    const purchaseValue = commissionTotals.purchaseValue;
    const summary = {
      ads: {
        ...adsTotals,
        ctrLink: safeDivide(adsTotals.linkClicks, adsTotals.impressions),
        cpcLink: safeDivide(adsTotals.spend, adsTotals.linkClicks),
        cpm: safeDivide(adsTotals.spend, adsTotals.impressions) * 1000,
        frequency: safeDivide(adsTotals.impressions, adsTotals.reach)
      },
      commission: {
        ...commissionTotals,
        commissionRoas: safeDivide(expectedCommission, adsTotals.spend),
        gmvRoas: safeDivide(purchaseValue, adsTotals.spend),
        roi: safeDivide(expectedCommission - adsTotals.spend, adsTotals.spend),
        breakEvenGmvRoas: expectedCommission > 0 && purchaseValue > 0 ? 1 / safeDivide(expectedCommission, purchaseValue) : 0
      }
    };

    const issues = [];
    if (!adsRows.length) issues.push({ level: "error", title: "Ads CSV missing", detail: "Tiada fail Ads dikesan dalam upload ini." });
    if (!commissionRows.length) issues.push({ level: "error", title: "Commission CSV missing", detail: "Tiada fail Affiliate Commission dikesan dalam upload ini." });
    meta.duplicateAds.forEach((item) => {
      issues.push({ level: "warning", title: "Duplicate Ads CSV ignored", detail: `${item.name} sama seperti ${item.original}.` });
    });
    if (meta.duplicateCommissionDetails.length > 0) {
      const inside = meta.duplicateCommissionDetails.filter((item) => item.scope === "inside");
      const across = meta.duplicateCommissionDetails.filter((item) => item.scope === "across");
      if (inside.length > 0) {
        issues.push({ level: "warning", title: "Duplicate inside uploaded commission file", detail: duplicateDetailText(inside) });
      }
      if (across.length > 0) {
        issues.push({ level: "warning", title: "Duplicate across multiple commission files", detail: duplicateDetailText(across) });
      }
    }
    meta.unknownFiles.forEach((name) => {
      issues.push({ level: "warning", title: "Unknown CSV", detail: `${name} tidak match schema Ads atau Commission.` });
    });
    unmappedRows.forEach((row) => {
      issues.push({
        level: "warning",
        title: "Unmapped Sub_id4",
        detail: `Order ${getField(row, "Order id") || "-"} guna Sub_id4="${getField(row, "Sub_id4")}", tidak boleh map kepada ad number.`
      });
    });
    ["Sub_id2", "Sub_id3", "Channel"].flatMap((field) => buildCasingIssues(expectedRows, field)).forEach((issue) => {
      issues.push({
        level: "warning",
        title: `Casing mismatch ${issue.field}`,
        detail: `${issue.variants.join(" / ")} patut diseragamkan.`
      });
    });
    if (hold.missingTimeRows > 0) {
      issues.push({ level: "warning", title: "Missing hold time", detail: `${hold.missingTimeRows} commission row tiada Click Time atau Order Time.` });
    }
    if (hold.invalidTimeOrders > 0) {
      issues.push({ level: "warning", title: "Invalid hold time", detail: `${hold.invalidTimeOrders} order ada Order Time lebih awal daripada Click Time.` });
    }

    return {
      version: CORE_VERSION,
      createdAt: new Date().toISOString(),
      files: meta.files,
      uploadSummary: buildUploadSummary(meta, adsRows, commissionRows),
      summary,
      perAd,
      attribution,
      categories,
      products,
      hold,
      audience: audienceRows,
      issues
    };
  }

  function analyzeUploads(filePayloads) {
    const adsFingerprints = new Map();
    const commissionRecords = new Map();
    const adsRows = [];
    const commissionRows = [];
    const meta = {
      files: [],
      duplicateAds: [],
      duplicateCommissionDetails: [],
      unknownFiles: []
    };

    filePayloads.forEach((file, fileIndex) => {
      const parsed = parseCsv(file.text);
      const type = detectFile(parsed);
      meta.files.push({ name: file.name, type, rows: parsed.rows.length });

      if (type === "ads") {
        const fingerprint = fingerprintRows(parsed.headers, parsed.rows);
        if (adsFingerprints.has(fingerprint)) {
          meta.duplicateAds.push({ name: file.name, original: adsFingerprints.get(fingerprint) });
          return;
        }
        adsFingerprints.set(fingerprint, file.name);
        adsRows.push(...parsed.rows);
        return;
      }

      if (type === "commission") {
        parsed.rows.forEach((row, rowIndex) => {
          const key = commissionKey(row);
          const previous = commissionRecords.get(key);
          if (previous) {
            const scope = previous.fileIndex === fileIndex ? "inside" : "across";
            const originalFile = previous.fileName;
            const originalRow = previous.rowNumber;
            const currentQuality = commissionRowQuality(row);
            const previousQuality = commissionRowQuality(previous.row);
            if (currentQuality > previousQuality) {
              commissionRows[previous.outputIndex] = row;
              previous.row = row;
              previous.fileName = file.name;
              previous.rowNumber = rowIndex + 2;
              previous.fileIndex = fileIndex;
            }
            meta.duplicateCommissionDetails.push({
              scope,
              orderId: duplicateOrderId(row),
              currentFile: file.name,
              currentRow: rowIndex + 2,
              originalFile,
              originalRow
            });
            return;
          }
          commissionRecords.set(key, {
            row,
            fileName: file.name,
            fileIndex,
            rowNumber: rowIndex + 2,
            outputIndex: commissionRows.length
          });
          commissionRows.push(row);
        });
        return;
      }

      meta.unknownFiles.push(file.name);
    });

    return computeAnalysis(adsRows, commissionRows, meta);
  }

  function formatMoney(value) {
    return money.format(Number.isFinite(value) ? value : 0);
  }

  function formatNumber(value) {
    return num.format(Number.isFinite(value) ? value : 0);
  }

  function formatDecimal(value) {
    return decimal.format(Number.isFinite(value) ? value : 0);
  }

  function formatPercent(value) {
    return `${formatDecimal((Number.isFinite(value) ? value : 0) * 100)}%`;
  }

  function duplicateDetailText(details) {
    const orderIds = [...new Set(details.map((item) => item.orderId).filter(Boolean))];
    const shown = orderIds.slice(0, 8).join(", ");
    const more = orderIds.length > 8 ? ` dan ${orderIds.length - 8} lagi` : "";
    const filePairs = [...new Set(details.map((item) => `${item.originalFile} -> ${item.currentFile}`))].slice(0, 3).join("; ");
    return `${details.length} row duplicate dibuang. Order: ${shown || "unknown"}${more}. File: ${filePairs}.`;
  }

  function cloneForSnapshot(value) {
    return JSON.parse(JSON.stringify(value || null));
  }

  function arrayValue(value) {
    return Array.isArray(value) ? value : [];
  }

  function numberValue(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function nestedValue(source, path) {
    return path.split(".").reduce((current, key) => (current && current[key] != null ? current[key] : 0), source);
  }

  function formatByType(value, type) {
    if (type === "money") return formatMoney(value);
    if (type === "percent") return formatPercent(value);
    if (type === "decimal") return formatDecimal(value);
    if (type === "duration") return formatDuration(value);
    return formatNumber(value);
  }

  function deltaClass(delta, direction = "higher") {
    if (!delta) return "muted-text";
    if (direction === "lower") return delta <= 0 ? "profit-text" : "loss-text";
    if (direction === "neutral") return "watch-text";
    return delta >= 0 ? "profit-text" : "loss-text";
  }

  function renderDelta(current, previous, type, direction) {
    const delta = numberValue(current) - numberValue(previous);
    const sign = delta > 0 ? "+" : "";
    return `<span class="delta ${deltaClass(delta, direction)}">${sign}${formatByType(delta, type)}</span>`;
  }

  function actionLabel(action) {
    if (!action) return "-";
    if (typeof action === "string") return action;
    return action.label || "-";
  }

  function buildUploadSummary(meta, adsRows, commissionRows) {
    const adsSelected = meta.files.filter((file) => file.type === "ads").length;
    const commissionSelected = meta.files.filter((file) => file.type === "commission").length;
    const unknownSelected = meta.files.filter((file) => file.type === "unknown").length;
    return {
      adsFilesSelected: adsSelected,
      adsFilesUsed: adsSelected - meta.duplicateAds.length,
      adsRowsUsed: adsRows.length,
      commissionFilesSelected: commissionSelected,
      commissionRowsUsed: commissionRows.length,
      duplicateAdsIgnored: meta.duplicateAds.length,
      duplicateCommissionRowsIgnored: meta.duplicateCommissionDetails.length,
      unknownFiles: unknownSelected
    };
  }

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(safeDivide(ms, 60 * 1000)));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days} hari ${hours} jam`;
    if (hours > 0) return `${hours} jam ${minutes} min`;
    return `${minutes} min`;
  }

  function formatVideoDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}j ${mins}m ${secs}s`;
    }
    return `${minutes}m ${secs}s`;
  }

  function formatBytes(bytes) {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value >= 1024 * 1024 * 1024) return `${formatDecimal(value / (1024 * 1024 * 1024))} GB`;
    if (value >= 1024 * 1024) return `${formatDecimal(value / (1024 * 1024))} MB`;
    if (value >= 1024) return `${formatDecimal(value / 1024)} KB`;
    return `${formatNumber(value)} B`;
  }

  function safeFileExtension(file) {
    const match = String(file && file.name ? file.name : "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1].replace(/[^a-z0-9]/g, "") : "mp4";
  }

  function aspectRatioText(width, height) {
    if (!width || !height) return "-";
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
  }

  function loadScriptOnce(src) {
    if (videoState.ffmpegScript) return videoState.ffmpegScript;
    videoState.ffmpegScript = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-dynamic-src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.dynamicSrc = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Gagal load ${src}`));
      document.head.appendChild(script);
    });
    return videoState.ffmpegScript;
  }

  async function readBlobAsBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function toBlobUrl(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Gagal download ${url}`);
    const blob = new Blob([await response.arrayBuffer()], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  function htmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderTable(container, columns, rows, emptyText) {
    if (!container) return;
    if (!rows.length) {
      container.innerHTML = `<p class="empty-state">${htmlEscape(emptyText || "Tiada data.")}</p>`;
      return;
    }
    const header = columns.map((column) => `<th class="${column.num ? "num" : ""}">${htmlEscape(column.label)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = columns.map((column) => {
        const value = column.render ? column.render(row) : row[column.key];
        return `<td class="${column.num ? "num" : ""}">${value}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    container.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function badge(action) {
    const tone = action && action.tone ? action.tone : "observe";
    const label = action && action.label ? action.label : "Observe";
    return `<span class="badge ${htmlEscape(tone)}">${htmlEscape(label)}</span>`;
  }

  function bar(value, max) {
    const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%"></div></div>`;
  }

  function verdictForAnalysis(analysis) {
    const roas = analysis.summary.commission.commissionRoas;
    const roi = analysis.summary.commission.roi;
    if (roas >= 1) return { tone: "profit", text: `Untung. Commission ROAS ${formatDecimal(roas)} dan ROI ${formatPercent(roi)}.` };
    if (roas >= 0.5) return { tone: "watch", text: `Belum break-even, tapi ada traction. Commission ROAS ${formatDecimal(roas)}.` };
    return { tone: "loss", text: `Rugi. Commission ROAS ${formatDecimal(roas)} dan ROI ${formatPercent(roi)}.` };
  }

  function renderAnalysis(analysis) {
    const summary = analysis.summary;
    const verdict = verdictForAnalysis(analysis);
    const statusPanel = document.getElementById("statusPanel");
    statusPanel.className = `status-panel ${verdict.tone}`;
    document.getElementById("statusMessage").textContent = verdict.text;

    document.getElementById("kpiSpend").textContent = formatMoney(summary.ads.spend);
    document.getElementById("kpiTraffic").textContent = `${formatNumber(summary.ads.linkClicks)} link clicks | CPC ${formatMoney(summary.ads.cpcLink)}`;
    document.getElementById("kpiExpected").textContent = formatMoney(summary.commission.expectedCommission);
    document.getElementById("kpiCompleted").textContent = `Completed ${formatMoney(summary.commission.completedCommission)}`;
    document.getElementById("kpiRoas").textContent = formatDecimal(summary.commission.commissionRoas);
    document.getElementById("kpiRoi").textContent = `ROI ${formatPercent(summary.commission.roi)}`;
    document.getElementById("kpiBeRoas").textContent = formatDecimal(summary.commission.breakEvenGmvRoas);
    document.getElementById("kpiRate").textContent = `Avg rate ${formatPercent(summary.commission.avgCommissionRate)}`;

    const line = summary.commission.commissionRoas < 1
      ? `Setiap RM1 ads baru balik ${formatMoney(summary.commission.commissionRoas)} komisyen.`
      : "Campaign sudah lepas modal berdasarkan expected commission.";
    document.getElementById("summaryLine").textContent = line;
    renderUploadSummary(analysis.uploadSummary);

    const metrics = [
      ["Impressions", formatNumber(summary.ads.impressions), `Reach ${formatNumber(summary.ads.reach)}`],
      ["CTR Link", formatPercent(summary.ads.ctrLink), `CPM ${formatMoney(summary.ads.cpm)}`],
      ["Orders Expected", formatNumber(summary.commission.orders), `${summary.commission.items} item rows`],
      ["Purchase Value", formatMoney(summary.commission.purchaseValue), `GMV ROAS ${formatDecimal(summary.commission.gmvRoas)}`],
      ["Pending Commission", formatMoney(summary.commission.pendingCommission), "Belum confirmed"],
      ["Completed Commission", formatMoney(summary.commission.completedCommission), "Confirmed risk check"],
      ["Avg Hold Time", formatDuration(analysis.hold.avgMs), `${formatPercent(analysis.hold.sameDayRate)} same-day`],
      ["Delayed Orders", formatPercent(analysis.hold.delayedRate), ">24 jam selepas click"],
      ["Break-even GMV", formatMoney(summary.ads.spend / Math.max(summary.commission.avgCommissionRate, 0.000001)), `Need ROAS ${formatDecimal(summary.commission.breakEvenGmvRoas)}`],
      ["Cancelled", formatNumber(summary.commission.cancelledOrders), `${summary.commission.cancelledItems} item rows`]
    ];

    document.getElementById("summaryGrid").innerHTML = metrics.map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");

    const maxAdRoas = Math.max(...analysis.perAd.map((row) => row.commissionRoas), 1);
    renderTable(document.getElementById("adTable"), [
      { label: "Ad", render: (row) => htmlEscape(row.adNo) },
      { label: "Action", render: (row) => badge(row.action) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Clicks", num: true, render: (row) => formatNumber(row.linkClicks) },
      { label: "CPC", num: true, render: (row) => formatMoney(row.cpcLink) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "ROAS", num: true, render: (row) => formatDecimal(row.commissionRoas) },
      { label: "ROI", num: true, render: (row) => `<span class="${row.roi >= 0 ? "profit-text" : "loss-text"}">${formatPercent(row.roi)}</span>` },
      { label: "Signal", render: (row) => `<div class="bar-cell">${bar(row.commissionRoas, maxAdRoas)}</div>` },
      { label: "Note", render: (row) => htmlEscape(row.action.note) }
    ], analysis.perAd, "Tiada data ad.");

    const maxAttr = Math.max(...analysis.attribution.map((row) => row.expectedCommission), 1);
    renderTable(document.getElementById("attributionTable"), [
      { label: "Type", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Rate", num: true, render: (row) => formatPercent(row.avgCommissionRate) },
      { label: "Bar", render: (row) => bar(row.expectedCommission, maxAttr) }
    ], analysis.attribution, "Tiada data attribution.");

    const maxCategory = Math.max(...analysis.categories.map((row) => row.expectedCommission), 1);
    renderTable(document.getElementById("categoryTable"), [
      { label: "Category", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Rate", num: true, render: (row) => formatPercent(row.avgCommissionRate) },
      { label: "Bar", render: (row) => bar(row.expectedCommission, maxCategory) }
    ], analysis.categories, "Tiada data category.");

    const maxHoldOrders = Math.max(...analysis.hold.buckets.map((row) => row.orders), 1);
    document.getElementById("holdSummary").innerHTML = [
      ["Orders With Time", formatNumber(analysis.hold.totalOrders), "Click Time -> Order Time"],
      ["Average Hold", formatDuration(analysis.hold.avgMs), `Median ${formatDuration(analysis.hold.medianMs)}`],
      ["Same-hour Rate", formatPercent(analysis.hold.sameHourRate), "Order dalam 1 jam"],
      ["Same-day Rate", formatPercent(analysis.hold.sameDayRate), "Order dalam 24 jam"],
      ["Delayed Rate", formatPercent(analysis.hold.delayedRate), "Order selepas 24 jam"],
      ["Longest Hold", formatDuration(analysis.hold.longestMs), "Cookie delay paling lama"]
    ].map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");

    renderTable(document.getElementById("holdTable"), [
      { label: "Hold Bucket", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "Hold Rate", num: true, render: (row) => formatPercent(row.rate) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Comm Share", num: true, render: (row) => formatPercent(row.commissionShare) },
      { label: "Signal", render: (row) => `<div class="bar-cell">${bar(row.orders, maxHoldOrders)}</div>` }
    ], analysis.hold.buckets, "Tiada data hold rate.");

    renderTable(document.getElementById("audienceTable"), [
      { label: "Age", render: (row) => htmlEscape(row.age) },
      { label: "Gender", render: (row) => htmlEscape(row.gender) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Impr.", num: true, render: (row) => formatNumber(row.impressions) },
      { label: "Clicks", num: true, render: (row) => formatNumber(row.linkClicks) },
      { label: "CTR", num: true, render: (row) => formatPercent(row.ctr) },
      { label: "CPC", num: true, render: (row) => formatMoney(row.cpc) }
    ], analysis.audience, "Tiada data audience.");

    renderIssues(analysis.issues);
    renderSnapshots(analysis);
    document.getElementById("saveSnapshotBtn").disabled = false;
  }

  function renderIssues(issues) {
    const container = document.getElementById("issuesList");
    if (!issues.length) {
      container.innerHTML = `<p class="empty-state">Tiada isu tracking dikesan.</p>`;
      return;
    }
    container.innerHTML = issues.map((issue) => (
      `<div class="issue-item ${htmlEscape(issue.level)}"><strong>${htmlEscape(issue.title)}</strong><span>${htmlEscape(issue.detail)}</span></div>`
    )).join("");
  }

  function renderUploadSummary(summary) {
    const container = document.getElementById("uploadSummary");
    if (!container) return;
    if (!summary) {
      container.className = "upload-summary";
      container.innerHTML = "";
      return;
    }
    container.className = "upload-summary active";
    const stats = [
      ["Ads Files Used", `${summary.adsFilesUsed}/${summary.adsFilesSelected}`, `${summary.adsRowsUsed} rows`],
      ["Commission Files", `${summary.commissionFilesSelected}`, `${summary.commissionRowsUsed} rows used`],
      ["Duplicate Ignored", `${summary.duplicateAdsIgnored + summary.duplicateCommissionRowsIgnored}`, `${summary.duplicateCommissionRowsIgnored} commission rows`],
      ["Unknown Files", `${summary.unknownFiles}`, "Rejected CSV"]
    ];
    container.innerHTML = stats.map(([label, value, note]) => (
      `<div class="upload-stat"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></div>`
    )).join("");
  }

  function clearCurrentAnalysisUi() {
    document.getElementById("statusPanel").className = "status-panel muted";
    document.getElementById("statusMessage").textContent = "Belum ada data dianalisis.";
    document.getElementById("saveSnapshotBtn").disabled = true;
    ["kpiSpend", "kpiTraffic", "kpiExpected", "kpiCompleted", "kpiRoas", "kpiRoi", "kpiBeRoas", "kpiRate"].forEach((id) => {
      document.getElementById(id).textContent = "-";
    });
    document.getElementById("summaryLine").textContent = "Upload CSV untuk mula.";
    document.getElementById("summaryGrid").innerHTML = "";
    document.getElementById("adTable").innerHTML = "";
    document.getElementById("attributionTable").innerHTML = "";
    document.getElementById("categoryTable").innerHTML = "";
    document.getElementById("holdSummary").innerHTML = "";
    document.getElementById("holdTable").innerHTML = "";
    document.getElementById("audienceTable").innerHTML = "";
    document.getElementById("issuesList").innerHTML = `<p class="empty-state">Belum ada analysis aktif.</p>`;
    document.getElementById("snapshotComparePanel").innerHTML = "";
    document.getElementById("snapshotName").value = "";
    document.getElementById("snapshotCompare").value = "";
    renderUploadSummary(null);
  }

  function loadSnapshots() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (_error) {
      return [];
    }
  }

  function saveSnapshots(snapshots) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots.slice(0, 30)));
  }

  function snapshotFromAnalysis(analysis, name) {
    return {
      id: `${Date.now()}`,
      name: name || `Snapshot ${new Date().toLocaleString("ms-MY")}`,
      createdAt: new Date().toISOString(),
      appVersion: CORE_VERSION,
      files: cloneForSnapshot(analysis.files),
      uploadSummary: cloneForSnapshot(analysis.uploadSummary),
      summary: cloneForSnapshot(analysis.summary),
      perAd: cloneForSnapshot(analysis.perAd),
      attribution: cloneForSnapshot(analysis.attribution),
      categories: cloneForSnapshot(analysis.categories),
      products: cloneForSnapshot(analysis.products),
      hold: cloneForSnapshot(analysis.hold),
      audience: cloneForSnapshot(analysis.audience),
      issues: cloneForSnapshot(analysis.issues)
    };
  }

  function renderSnapshots(currentAnalysis) {
    const snapshots = loadSnapshots();
    const list = document.getElementById("snapshotList");
    const compare = document.getElementById("snapshotCompare");
    compare.innerHTML = `<option value="">Pilih snapshot untuk compare</option>${snapshots.map((snapshot) => (
      `<option value="${htmlEscape(snapshot.id)}">${htmlEscape(snapshot.name)}</option>`
    )).join("")}`;

    if (!snapshots.length) {
      list.innerHTML = `<p class="empty-state">Belum ada snapshot.</p>`;
      document.getElementById("snapshotComparePanel").innerHTML = "";
      return;
    }

    list.innerHTML = snapshots.map((snapshot) => (
      `<div class="snapshot-item">
        <div>
          <strong>${htmlEscape(snapshot.name)}</strong>
          <div class="snapshot-meta">${new Date(snapshot.createdAt).toLocaleString("ms-MY")} | Spend ${formatMoney(snapshot.summary.ads.spend)} | Comm ${formatMoney(snapshot.summary.commission.expectedCommission)}</div>
        </div>
        <button class="btn danger" type="button" data-delete-snapshot="${htmlEscape(snapshot.id)}">Delete</button>
      </div>`
    )).join("");

    list.querySelectorAll("[data-delete-snapshot]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = loadSnapshots().filter((snapshot) => snapshot.id !== button.dataset.deleteSnapshot);
        saveSnapshots(next);
        renderSnapshots(currentAnalysis);
      });
    });
  }

  function renderCompareMetric(label, current, previous, type, direction) {
    return `
      <div class="compare-metric">
        <span>${htmlEscape(label)}</span>
        <strong>${formatByType(current, type)}</strong>
        <small>Snapshot ${formatByType(previous, type)} ${renderDelta(current, previous, type, direction)}</small>
      </div>`;
  }

  function renderKpiCompare(currentAnalysis, snapshot) {
    const current = currentAnalysis.summary || {};
    const previous = snapshot.summary || {};
    const metrics = [
      ["Spend", "ads.spend", "money", "neutral"],
      ["Link Clicks", "ads.linkClicks", "number", "higher"],
      ["Expected Comm", "commission.expectedCommission", "money", "higher"],
      ["Completed Comm", "commission.completedCommission", "money", "higher"],
      ["Orders", "commission.orders", "number", "higher"],
      ["Commission ROAS", "commission.commissionRoas", "decimal", "higher"],
      ["ROI", "commission.roi", "percent", "higher"],
      ["Avg Comm Rate", "commission.avgCommissionRate", "percent", "higher"],
      ["Purchase Value", "commission.purchaseValue", "money", "higher"],
      ["BE GMV ROAS", "commission.breakEvenGmvRoas", "decimal", "lower"],
      ["Same-day Hold", "hold.sameDayRate", "percent", "higher"],
      ["Delayed Orders", "hold.delayedRate", "percent", "lower"]
    ];

    const cards = metrics.map(([label, path, type, direction]) => {
      const currentSource = path.startsWith("hold.") ? currentAnalysis : current;
      const previousSource = path.startsWith("hold.") ? snapshot : previous;
      const cleanPath = path.startsWith("hold.") ? path : path;
      return renderCompareMetric(label, nestedValue(currentSource, cleanPath), nestedValue(previousSource, cleanPath), type, direction);
    }).join("");

    return `<section class="compare-block"><h3>KPI Summary</h3><div class="compare-metrics">${cards}</div></section>`;
  }

  function renderUploadCompare(currentAnalysis, snapshot) {
    const current = currentAnalysis.uploadSummary || {};
    const previous = snapshot.uploadSummary || {};
    const rows = [
      ["Ads files used", `${numberValue(current.adsFilesUsed)}/${numberValue(current.adsFilesSelected)}`, `${numberValue(previous.adsFilesUsed)}/${numberValue(previous.adsFilesSelected)}`],
      ["Ads rows used", formatNumber(numberValue(current.adsRowsUsed)), formatNumber(numberValue(previous.adsRowsUsed))],
      ["Commission files", formatNumber(numberValue(current.commissionFilesSelected)), formatNumber(numberValue(previous.commissionFilesSelected))],
      ["Commission rows used", formatNumber(numberValue(current.commissionRowsUsed)), formatNumber(numberValue(previous.commissionRowsUsed))],
      ["Duplicate rows ignored", formatNumber(numberValue(current.duplicateAdsIgnored) + numberValue(current.duplicateCommissionRowsIgnored)), formatNumber(numberValue(previous.duplicateAdsIgnored) + numberValue(previous.duplicateCommissionRowsIgnored))],
      ["Unknown files", formatNumber(numberValue(current.unknownFiles)), formatNumber(numberValue(previous.unknownFiles))]
    ];

    return `
      <section class="compare-block">
        <h3>Upload Summary</h3>
        <div class="compare-list">
          ${rows.map(([label, currentText, previousText]) => (
            `<div><span>${htmlEscape(label)}</span><strong>${htmlEscape(currentText)}</strong><small>Snapshot ${htmlEscape(previousText)}</small></div>`
          )).join("")}
        </div>
      </section>`;
  }

  function rowKey(row, keyName) {
    return String(row && row[keyName] != null ? row[keyName] : "").trim();
  }

  function compareKeys(currentRows, previousRows, keyFn) {
    const keys = [];
    const seen = new Set();
    currentRows.forEach((row) => {
      const key = keyFn(row);
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
    previousRows.forEach((row) => {
      const key = keyFn(row);
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
    return keys;
  }

  function renderCompareCell(currentRow, previousRow, column) {
    if (column.render) return column.render(currentRow, previousRow);
    const current = nestedValue(currentRow || {}, column.path);
    const previous = nestedValue(previousRow || {}, column.path);
    return `<div class="compare-cell"><strong>${formatByType(current, column.type)}</strong>${renderDelta(current, previous, column.type, column.direction)}</div>`;
  }

  function renderDimensionCompare(title, currentRows, previousRows, keyFn, columns, emptyText) {
    const current = arrayValue(currentRows);
    const previous = arrayValue(previousRows);
    if (!current.length && !previous.length) {
      return `<section class="compare-block"><h3>${htmlEscape(title)}</h3><p class="empty-state">${htmlEscape(emptyText || "Tiada data untuk compare.")}</p></section>`;
    }

    const currentMap = new Map(current.map((row) => [keyFn(row), row]));
    const previousMap = new Map(previous.map((row) => [keyFn(row), row]));
    const keys = compareKeys(current, previous, keyFn);
    const header = columns.map((column) => `<th class="${column.num ? "num" : ""}">${htmlEscape(column.label)}</th>`).join("");
    const body = keys.map((key) => {
      const currentRow = currentMap.get(key);
      const previousRow = previousMap.get(key);
      const status = currentRow && previousRow ? "" : currentRow ? "Baru" : "Hilang";
      const statusBadge = status ? `<span class="compare-status">${htmlEscape(status)}</span>` : "";
      const cells = columns.map((column) => `<td class="${column.num ? "num" : ""}">${renderCompareCell(currentRow, previousRow, column)}</td>`).join("");
      return `<tr><td><strong>${htmlEscape(key)}</strong>${statusBadge}</td>${cells}</tr>`;
    }).join("");
    const note = !previous.length && current.length ? `<p class="compare-note">Snapshot lama mungkin belum simpan data section ini.</p>` : "";

    return `
      <section class="compare-block">
        <h3>${htmlEscape(title)}</h3>
        ${note}
        <div class="table-wrap compare-table">
          <table><thead><tr><th>Key</th>${header}</tr></thead><tbody>${body}</tbody></table>
        </div>
      </section>`;
  }

  function renderAdCompare(currentAnalysis, snapshot) {
    return renderDimensionCompare(
      "Ad / Sub_id4 Ranking",
      arrayValue(currentAnalysis.perAd),
      arrayValue(snapshot.perAd),
      (row) => rowKey(row, "adNo"),
      [
        {
          label: "Action",
          render: (currentRow, previousRow) => `<div class="compare-cell"><strong>${htmlEscape(actionLabel(currentRow && currentRow.action))}</strong><small>Snapshot ${htmlEscape(actionLabel(previousRow && previousRow.action))}</small></div>`
        },
        { label: "Spend", path: "spend", type: "money", direction: "neutral", num: true },
        { label: "Clicks", path: "linkClicks", type: "number", direction: "higher", num: true },
        { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
        { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
        { label: "ROAS", path: "commissionRoas", type: "decimal", direction: "higher", num: true },
        { label: "ROI", path: "roi", type: "percent", direction: "higher", num: true }
      ],
      "Tiada data ad."
    );
  }

  function renderGroupCompare(title, currentRows, previousRows, keyName) {
    return renderDimensionCompare(
      title,
      currentRows,
      previousRows,
      (row) => rowKey(row, keyName),
      [
        { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
        { label: "Items", path: "items", type: "number", direction: "higher", num: true },
        { label: "PV", path: "purchaseValue", type: "money", direction: "higher", num: true },
        { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
        { label: "Rate", path: "avgCommissionRate", type: "percent", direction: "higher", num: true }
      ],
      `Tiada data ${title.toLowerCase()}.`
    );
  }

  function renderHoldCompare(currentAnalysis, snapshot) {
    const currentHold = currentAnalysis.hold || {};
    const previousHold = snapshot.hold || {};
    const metrics = [
      ["Orders With Time", "totalOrders", "number", "higher"],
      ["Average Hold", "avgMs", "duration", "lower"],
      ["Median Hold", "medianMs", "duration", "lower"],
      ["Same-hour Rate", "sameHourRate", "percent", "higher"],
      ["Same-day Rate", "sameDayRate", "percent", "higher"],
      ["Delayed Rate", "delayedRate", "percent", "lower"],
      ["Longest Hold", "longestMs", "duration", "lower"],
      ["Hold Comm", "totalCommission", "money", "higher"]
    ];
    const metricCards = metrics.map(([label, path, type, direction]) => (
      renderCompareMetric(label, nestedValue(currentHold, path), nestedValue(previousHold, path), type, direction)
    )).join("");

    return `
      <section class="compare-block">
        <h3>Hold Rate / Cookie Delay</h3>
        <div class="compare-metrics">${metricCards}</div>
        ${renderDimensionCompare(
          "Hold Buckets",
          arrayValue(currentHold.buckets),
          arrayValue(previousHold.buckets),
          (row) => rowKey(row, "key"),
          [
            { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
            { label: "Hold Rate", path: "rate", type: "percent", direction: "higher", num: true },
            { label: "PV", path: "purchaseValue", type: "money", direction: "higher", num: true },
            { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
            { label: "Comm Share", path: "commissionShare", type: "percent", direction: "higher", num: true }
          ],
          "Tiada data hold bucket."
        )}
      </section>`;
  }

  function renderAudienceCompare(currentAnalysis, snapshot) {
    return renderDimensionCompare(
      "Audience",
      arrayValue(currentAnalysis.audience),
      arrayValue(snapshot.audience),
      (row) => `${rowKey(row, "age")} | ${rowKey(row, "gender")}`,
      [
        { label: "Spend", path: "spend", type: "money", direction: "neutral", num: true },
        { label: "Impr.", path: "impressions", type: "number", direction: "higher", num: true },
        { label: "Clicks", path: "linkClicks", type: "number", direction: "higher", num: true },
        { label: "CTR", path: "ctr", type: "percent", direction: "higher", num: true },
        { label: "CPC", path: "cpc", type: "money", direction: "lower", num: true }
      ],
      "Tiada data audience."
    );
  }

  function renderIssueListForCompare(issues) {
    const rows = arrayValue(issues);
    if (!rows.length) return `<p class="empty-state">Tiada isu.</p>`;
    return rows.map((issue) => (
      `<div class="compare-issue"><strong>${htmlEscape(issue.title || "-")}</strong><span>${htmlEscape(issue.detail || "")}</span></div>`
    )).join("");
  }

  function renderIssueCompare(currentAnalysis, snapshot) {
    const currentIssues = arrayValue(currentAnalysis.issues);
    const previousIssues = arrayValue(snapshot.issues);
    return `
      <section class="compare-block">
        <h3>Tracking Issues</h3>
        <div class="compare-issue-grid">
          <div>
            <h4>Current (${formatNumber(currentIssues.length)})</h4>
            ${renderIssueListForCompare(currentIssues)}
          </div>
          <div>
            <h4>Snapshot (${formatNumber(previousIssues.length)})</h4>
            ${renderIssueListForCompare(previousIssues)}
          </div>
        </div>
      </section>`;
  }

  function renderCompare(currentAnalysis, snapshotId) {
    const panel = document.getElementById("snapshotComparePanel");
    if (!snapshotId) {
      panel.innerHTML = "";
      return;
    }
    const snapshot = loadSnapshots().find((item) => item.id === snapshotId);
    if (!snapshot) {
      panel.innerHTML = "";
      return;
    }
    if (!currentAnalysis) {
      panel.innerHTML = `<div class="compare-card"><strong>Compare vs ${htmlEscape(snapshot.name)}</strong><p class="empty-state">Upload dan tekan Analisis dahulu untuk compare dengan snapshot ini.</p></div>`;
      return;
    }

    panel.innerHTML = `
      <div class="compare-card">
        <strong>Compare current analysis vs ${htmlEscape(snapshot.name)}</strong>
        ${renderKpiCompare(currentAnalysis, snapshot)}
        ${renderUploadCompare(currentAnalysis, snapshot)}
        ${renderAdCompare(currentAnalysis, snapshot)}
        ${renderGroupCompare("Attribution", arrayValue(currentAnalysis.attribution), arrayValue(snapshot.attribution), "key")}
        ${renderGroupCompare("Category", arrayValue(currentAnalysis.categories), arrayValue(snapshot.categories), "key")}
        ${renderGroupCompare("Product", arrayValue(currentAnalysis.products), arrayValue(snapshot.products), "key")}
        ${renderHoldCompare(currentAnalysis, snapshot)}
        ${renderAudienceCompare(currentAnalysis, snapshot)}
        ${renderIssueCompare(currentAnalysis, snapshot)}
      </div>`;
  }

  async function readFiles(files) {
    const payloads = [];
    for (const file of files) {
      const text = await file.text();
      payloads.push({ name: file.name, size: file.size, text });
    }
    return payloads;
  }

  function updateFileList(files) {
    const list = document.getElementById("fileList");
    if (!files.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = [...files].map((file) => `<span class="file-pill">${htmlEscape(file.name)}</span>`).join("");
  }

  function setActivePage(page) {
    const isVideo = page === "video";
    document.body.dataset.page = isVideo ? "video" : "performance";
    document.getElementById("performancePage").hidden = isVideo;
    document.getElementById("videoPage").hidden = !isVideo;
    document.getElementById("performanceActions").hidden = isVideo;
    document.getElementById("appTitle").textContent = isVideo ? "Video Converter" : "Performance Dashboard";
    document.getElementById("pageEyebrow").textContent = isVideo ? "Browser Video Tool" : "Shopee Affiliate Cookies";
    document.querySelectorAll("[data-page-target]").forEach((button) => {
      button.classList.toggle("active", button.dataset.pageTarget === (isVideo ? "video" : "performance"));
    });
  }

  function setVideoStatus(tone, message) {
    const panel = document.getElementById("videoStatus");
    panel.className = `status-panel ${tone || "muted"}`;
    panel.querySelector("span").textContent = message;
  }

  function setVideoProgress(value, message) {
    const percent = Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 0) * 100)));
    document.getElementById("videoProgressFill").style.width = `${percent}%`;
    document.getElementById("videoProgressText").textContent = `${percent}%`;
    if (message) setVideoStatus("watch", message);
  }

  function appendVideoLog(message) {
    const log = document.getElementById("videoLog");
    const clean = String(message || "").trim();
    if (!clean) return;
    const current = log.textContent === "Belum ada proses." ? "" : log.textContent;
    log.textContent = `${current}${current ? "\n" : ""}${clean}`.split("\n").slice(-60).join("\n");
    log.scrollTop = log.scrollHeight;
  }

  function clearVideoOutput() {
    if (videoState.outputUrl) URL.revokeObjectURL(videoState.outputUrl);
    videoState.outputUrl = "";
    videoState.outputSize = 0;
    const link = document.getElementById("downloadVideoLink");
    link.href = "#";
    link.download = "converted-video.mp4";
    link.classList.add("disabled");
    link.setAttribute("aria-disabled", "true");
    document.getElementById("videoOutputSummary").className = "upload-summary";
    document.getElementById("videoOutputSummary").innerHTML = "";
  }

  async function deleteVirtualVideoFiles() {
    if (!videoState.ffmpeg) return;
    const names = [videoState.inputName, videoState.outputName].filter(Boolean);
    for (const name of names) {
      try {
        await videoState.ffmpeg.deleteFile(name);
      } catch (_error) {
        // File may already be gone after a reset or failed conversion.
      }
    }
    videoState.inputName = "";
    videoState.outputName = "";
  }

  function videoOrientation(width, height) {
    if (!width || !height) return "vertical";
    if (height > width) return "vertical";
    if (width > height) return "landscape";
    return "square";
  }

  function videoFilterForTarget(targetHeight) {
    const target = Number.parseInt(targetHeight, 10) || 720;
    const orientation = videoOrientation(videoState.metadata.width, videoState.metadata.height);
    const longSide = Math.round(target * 16 / 9);
    if (orientation === "vertical") {
      return `scale=${target}:${longSide}:force_original_aspect_ratio=increase:flags=lanczos,crop=${target}:${longSide},setsar=1`;
    }
    if (orientation === "landscape") {
      return `scale=${longSide}:${target}:force_original_aspect_ratio=increase:flags=lanczos,crop=${longSide}:${target},setsar=1`;
    }
    return `scale=${target}:${target}:flags=lanczos,setsar=1`;
  }

  function shopeeSafeCheck(width, height, targetHeight) {
    const target = Number.parseInt(targetHeight, 10) || 720;
    const longSide = Math.round(target * 16 / 9);
    const orientation = videoOrientation(width, height);
    let pass = false;
    let required = `${target} x ${longSide}`;

    if (orientation === "vertical") {
      pass = width >= target && height >= longSide;
      required = `${target} x ${longSide}`;
    } else if (orientation === "landscape") {
      pass = width >= longSide && height >= target;
      required = `${longSide} x ${target}`;
    } else {
      pass = width >= target && height >= target;
      required = `${target} x ${target}`;
    }

    return {
      pass,
      orientation,
      required,
      label: pass ? "Pass" : "Warning",
      note: pass ? "Shopee-safe resolution" : `Perlu minimum ${required}`
    };
  }

  async function readVideoMetadataFromUrl(url) {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
      };
      video.onloadedmetadata = () => {
        const metadata = {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          duration: Number.isFinite(video.duration) ? video.duration : 0
        };
        cleanup();
        resolve(metadata);
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("Gagal baca metadata output video."));
      };
      video.src = url;
    });
  }

  function renderVideoWarning() {
    const warning = document.getElementById("videoWarning");
    const messages = [];
    if (videoState.file && videoState.file.size > VIDEO_SIZE_WARNING_BYTES) {
      messages.push(`File lebih ${formatBytes(VIDEO_SIZE_WARNING_BYTES)}; conversion mungkin lambat terutama di phone.`);
    }
    if (videoState.metadata.duration > VIDEO_DURATION_WARNING_SECONDS) {
      messages.push(`Video lebih ${formatVideoDuration(VIDEO_DURATION_WARNING_SECONDS)}; browser mungkin berat.`);
    }
    if (!messages.length) {
      warning.hidden = true;
      warning.innerHTML = "";
      return;
    }
    warning.hidden = false;
    warning.innerHTML = `<strong>Soft warning</strong><span>${htmlEscape(messages.join(" "))}</span>`;
  }

  function renderVideoMetadata() {
    const file = videoState.file;
    document.getElementById("videoMetaName").textContent = file ? file.name : "-";
    document.getElementById("videoMetaType").textContent = file ? file.type || "Unknown type" : "-";
    document.getElementById("videoMetaSize").textContent = file ? formatBytes(file.size) : "-";
    document.getElementById("videoMetaDuration").textContent = videoState.metadata.duration ? formatVideoDuration(videoState.metadata.duration) : "-";
    document.getElementById("videoMetaDurationNote").textContent = videoState.metadata.duration ? "Detected dari preview" : "-";
    document.getElementById("videoMetaResolution").textContent = videoState.metadata.width ? `${videoState.metadata.width} x ${videoState.metadata.height}` : "-";
    document.getElementById("videoMetaRatio").textContent = aspectRatioText(videoState.metadata.width, videoState.metadata.height);
    renderVideoWarning();
  }

  function resetVideoDom() {
    document.getElementById("videoFileInput").value = "";
    document.getElementById("videoFileName").innerHTML = "";
    const preview = document.getElementById("inputVideoPreview");
    preview.removeAttribute("src");
    preview.hidden = true;
    preview.load();
    document.getElementById("videoWarning").hidden = true;
    document.getElementById("videoWarning").innerHTML = "";
    document.getElementById("videoLog").textContent = "Belum ada proses.";
    document.getElementById("convertVideoBtn").disabled = true;
    setVideoProgress(0);
    setVideoStatus("muted", "Pilih video untuk mula.");
    renderVideoMetadata();
  }

  async function resetVideoWorkspace() {
    await deleteVirtualVideoFiles();
    clearVideoOutput();
    if (videoState.previewUrl) URL.revokeObjectURL(videoState.previewUrl);
    videoState.file = null;
    videoState.previewUrl = "";
    videoState.metadata = { duration: 0, width: 0, height: 0 };
    videoState.converting = false;
    resetVideoDom();
  }

  function updateOutputSummary(targetHeight, preset, outputMetadata) {
    const summary = document.getElementById("videoOutputSummary");
    summary.className = "upload-summary active";
    const width = outputMetadata && outputMetadata.width ? outputMetadata.width : 0;
    const height = outputMetadata && outputMetadata.height ? outputMetadata.height : 0;
    const safe = shopeeSafeCheck(width, height, targetHeight);
    const safeClass = safe.pass ? "profit-text" : "watch-text";
    const stats = [
      ["Output", "MP4", `${targetHeight}p`],
      ["Resolution", width && height ? `${width} x ${height}` : "-", safe.orientation],
      ["Shopee Safe Check", safe.label, safe.note],
      ["Quality", QUALITY_PRESETS[preset].label, `CRF ${QUALITY_PRESETS[preset].crf}`],
      ["Output Size", formatBytes(videoState.outputSize), "Siap untuk download"]
    ];
    summary.innerHTML = stats.map(([label, value, note]) => (
      `<div class="upload-stat"><span>${htmlEscape(label)}</span><strong class="${label === "Shopee Safe Check" ? safeClass : ""}">${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></div>`
    )).join("");
  }

  function loadVideoFile(file) {
    clearVideoOutput();
    if (videoState.previewUrl) URL.revokeObjectURL(videoState.previewUrl);
    videoState.file = file;
    videoState.metadata = { duration: 0, width: 0, height: 0 };
    videoState.previewUrl = URL.createObjectURL(file);

    document.getElementById("videoFileName").innerHTML = `<span class="file-pill">${htmlEscape(file.name)}</span>`;
    const preview = document.getElementById("inputVideoPreview");
    preview.src = videoState.previewUrl;
    preview.hidden = false;
    preview.onloadedmetadata = () => {
      videoState.metadata = {
        duration: preview.duration || 0,
        width: preview.videoWidth || 0,
        height: preview.videoHeight || 0
      };
      renderVideoMetadata();
    };
    document.getElementById("convertVideoBtn").disabled = false;
    document.getElementById("videoLog").textContent = "Video loaded. Sedia convert.";
    setVideoProgress(0);
    setVideoStatus("muted", "Video dipilih. Pilih setting dan tekan Convert.");
    renderVideoMetadata();
  }

  async function ensureFfmpegEngine() {
    if (videoState.ffmpeg) return videoState;
    if (videoState.loadingEngine) return videoState.loadingEngine;

    videoState.loadingEngine = (async () => {
      try {
        setVideoProgress(0.05, "Loading FFmpeg engine untuk first-time use...");
        appendVideoLog(`Loading ffmpeg.wasm ${FFMPEG_VERSION} wrapper...`);
        await loadScriptOnce(FFMPEG_LOCAL_SCRIPT);
        const FFmpegClass = window.FFmpegWASM && window.FFmpegWASM.FFmpeg;
        if (!FFmpegClass) throw new Error("FFmpeg wrapper tidak tersedia.");
        appendVideoLog("Loading ffmpeg.wasm core...");
        const [coreURL, wasmURL] = await Promise.all([
          toBlobUrl(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
          toBlobUrl(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, "application/wasm")
        ]);
        const ffmpeg = new FFmpegClass();
        ffmpeg.on("log", ({ message }) => appendVideoLog(message));
        ffmpeg.on("progress", ({ progress }) => {
          if (videoState.converting) setVideoProgress(Math.max(0.08, Math.min(0.98, progress || 0)), "Converting video...");
        });
        await ffmpeg.load({
          coreURL,
          wasmURL
        });
        videoState.ffmpeg = ffmpeg;
        appendVideoLog("FFmpeg engine ready.");
        return videoState;
      } catch (error) {
        videoState.loadingEngine = null;
        throw new Error(`FFmpeg engine belum boleh dimuat. Semak internet untuk first-time load, kemudian cuba lagi. ${error.message || error}`);
      }
    })();
    return videoState.loadingEngine;
  }

  function currentTargetHeight() {
    const checked = document.querySelector("input[name='targetHeight']:checked");
    return checked ? checked.value : "720";
  }

  function currentQualityPreset() {
    const value = document.getElementById("qualityPreset").value;
    return QUALITY_PRESETS[value] ? value : "balanced";
  }

  async function convertVideo() {
    if (!videoState.file || videoState.converting) return;
    const targetHeight = currentTargetHeight();
    const preset = currentQualityPreset();
    const quality = QUALITY_PRESETS[preset];
    const videoFilter = videoFilterForTarget(targetHeight);
    const inputName = `input.${safeFileExtension(videoState.file)}`;
    const outputName = `output-${targetHeight}p.mp4`;

    videoState.converting = true;
    document.getElementById("convertVideoBtn").disabled = true;
    clearVideoOutput();
    await deleteVirtualVideoFiles();
    videoState.inputName = inputName;
    videoState.outputName = outputName;
    document.getElementById("videoLog").textContent = "Preparing conversion...";
    setVideoProgress(0.03, "Preparing video...");

    try {
      const engine = await ensureFfmpegEngine();
      appendVideoLog(`Writing ${inputName} to memory...`);
      await engine.ffmpeg.writeFile(inputName, await readBlobAsBytes(videoState.file));
      const args = [
        "-i", inputName,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", videoFilter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", quality.crf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-sn",
        outputName
      ];
      appendVideoLog(`Command: ffmpeg ${args.join(" ")}`);
      const code = await engine.ffmpeg.exec(args);
      if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);
      const data = await engine.ffmpeg.readFile(outputName);
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      videoState.outputSize = blob.size;
      videoState.outputUrl = URL.createObjectURL(blob);
      const outputMetadata = await readVideoMetadataFromUrl(videoState.outputUrl);
      const safe = shopeeSafeCheck(outputMetadata.width, outputMetadata.height, targetHeight);
      const link = document.getElementById("downloadVideoLink");
      link.href = videoState.outputUrl;
      link.download = `${videoState.file.name.replace(/\.[^.]+$/, "")}-shopee-${targetHeight}p.mp4`;
      link.classList.remove("disabled");
      link.setAttribute("aria-disabled", "false");
      updateOutputSummary(targetHeight, preset, outputMetadata);
      setVideoProgress(1, "Conversion siap. Download MP4 tersedia.");
      setVideoStatus(safe.pass ? "profit" : "watch", safe.pass ? "Conversion siap dan resolution Shopee-safe." : "Conversion siap, tapi resolution masih perlu disemak.");
    } catch (error) {
      clearVideoOutput();
      await deleteVirtualVideoFiles();
      appendVideoLog(`Error: ${error.message || error}`);
      setVideoStatus("loss", error.message || "Conversion gagal.");
      setVideoProgress(0);
    } finally {
      videoState.converting = false;
      document.getElementById("convertVideoBtn").disabled = !videoState.file;
    }
  }

  function initVideoConverter() {
    const input = document.getElementById("videoFileInput");
    const convertBtn = document.getElementById("convertVideoBtn");
    const resetBtn = document.getElementById("resetVideoBtn");
    const downloadLink = document.getElementById("downloadVideoLink");

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        resetVideoWorkspace();
        return;
      }
      if (!file.type.startsWith("video/")) {
        setVideoStatus("loss", "Fail ini bukan video yang browser boleh baca.");
        input.value = "";
        return;
      }
      loadVideoFile(file);
    });

    convertBtn.addEventListener("click", convertVideo);
    resetBtn.addEventListener("click", () => resetVideoWorkspace());
    downloadLink.addEventListener("click", (event) => {
      if (!videoState.outputUrl) {
        event.preventDefault();
        return;
      }
      setTimeout(() => resetVideoWorkspace(), 900);
    });
  }

  function initDashboard() {
    let currentAnalysis = null;
    const fileInput = document.getElementById("fileInput");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const saveBtn = document.getElementById("saveSnapshotBtn");
    const clearBtn = document.getElementById("clearBtn");
    const compareSelect = document.getElementById("snapshotCompare");

    document.querySelectorAll("[data-page-target]").forEach((button) => {
      button.addEventListener("click", () => setActivePage(button.dataset.pageTarget));
    });
    initVideoConverter();
    renderSnapshots(null);
    clearCurrentAnalysisUi();
    renderVideoMetadata();

    fileInput.addEventListener("change", () => updateFileList(fileInput.files || []));

    analyzeBtn.addEventListener("click", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) {
        document.getElementById("statusPanel").className = "status-panel watch";
        document.getElementById("statusMessage").textContent = "Pilih sekurang-kurangnya satu CSV dahulu.";
        return;
      }
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "Menganalisis...";
      try {
        const payloads = await readFiles(files);
        currentAnalysis = analyzeUploads(payloads);
        renderAnalysis(currentAnalysis);
      } catch (error) {
        document.getElementById("statusPanel").className = "status-panel loss";
        document.getElementById("statusMessage").textContent = `Gagal analisis: ${error.message}`;
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Analisis";
      }
    });

    saveBtn.addEventListener("click", () => {
      if (!currentAnalysis) return;
      const name = document.getElementById("snapshotName").value.trim();
      const snapshots = loadSnapshots();
      snapshots.unshift(snapshotFromAnalysis(currentAnalysis, name));
      saveSnapshots(snapshots);
      document.getElementById("snapshotName").value = "";
      renderSnapshots(currentAnalysis);
    });

    compareSelect.addEventListener("change", () => renderCompare(currentAnalysis, compareSelect.value));

    clearBtn.addEventListener("click", () => {
      currentAnalysis = null;
      fileInput.value = "";
      updateFileList([]);
      clearCurrentAnalysisUi();
      renderSnapshots(null);
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    }
  }

  const core = {
    CORE_VERSION,
    parseCsv,
    detectFile,
    analyzeUploads,
    parseNumber,
    normalizeSubId4,
    normalizeAdNo
  };

  if (typeof window !== "undefined") {
    window.ShopeeDashboardCore = core;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = core;
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  }
}());
