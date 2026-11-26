// ============================================================================
// AERONAV HAHO - Core Geodesy, MGRS/WGRS Engine & PWA Auto-Updater
// ============================================================================

const AeronavCore = (() => {
  const R_EARTH = 6378137.0;
  const FT_TO_M = 0.3048;
  const M_TO_FT = 3.280839895;
  const KT_TO_MS = 0.514444444;
  const MS_TO_KT = 1.943844492;

  function toRad(deg) { return deg * Math.PI / 180; }
  function toDeg(rad) { return rad * 180 / Math.PI; }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
              Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function destinationPoint(lat, lon, bearingDeg, distMeters) {
    const angDist = distMeters / R_EARTH;
    const brng = toRad(bearingDeg);
    const phi1 = toRad(lat);
    const lam1 = toRad(lon);

    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(angDist) +
      Math.cos(phi1) * Math.sin(angDist) * Math.cos(brng)
    );
    const lam2 = lam1 + Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(phi1),
      Math.cos(angDist) - Math.sin(phi1) * Math.sin(phi2)
    );

    return {
      lat: toDeg(phi2),
      lon: ((toDeg(lam2) + 540) % 360) - 180
    };
  }

  function crossTrackMeters(latCurr, lonCurr, latStart, lonStart, latEnd, lonEnd) {
    const d13 = distanceMeters(latStart, lonStart, latCurr, lonCurr) / R_EARTH;
    const th13 = toRad(bearingDegrees(latStart, lonStart, latCurr, lonCurr));
    const th12 = toRad(bearingDegrees(latStart, lonStart, latEnd, lonEnd));
    return Math.asin(Math.sin(d13) * Math.sin(th13 - th12)) * R_EARTH;
  }

  const UTM_A = 6378137.0;
  const UTM_ECC_SQ = 0.00669438;
  const UTM_K0 = 0.9996;
  const LAT_BANDS = "CDEFGHJKLMNPQRSTUVWX";
  const SET_ORIGIN_COL = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
  const SET_ORIGIN_ROW = ["ABCDEFGHJKLMNPQRSTUV", "FGHJKLMNPQRSTUVABCDE"];

  function getUtmZone(lat, lon) {
    let zone = Math.floor((lon + 180) / 6) + 1;
    if (lat >= 56.0 && lat < 64.0 && lon >= 3.0 && lon < 12.0) zone = 32;
    if (lat >= 72.0 && lat < 84.0) {
      if (lon >= 0.0 && lon < 9.0) zone = 31;
      else if (lon >= 9.0 && lon < 21.0) zone = 33;
      else if (lon >= 21.0 && lon < 33.0) zone = 35;
      else if (lon >= 33.0 && lon < 42.0) zone = 37;
    }
    return zone;
  }

  function getLatBand(lat) {
    if (lat < -80 || lat > 84) return null;
    const idx = Math.floor((lat + 80) / 8);
    return LAT_BANDS[Math.min(idx, LAT_BANDS.length - 1)];
  }

  function latLonToUtm(lat, lon) {
    const zone = getUtmZone(lat, lon);
    const band = getLatBand(lat);
    if (!band) throw new Error("Latitudine fuori range MGRS (-80°..+84°)");

    const latRad = toRad(lat);
    const lonRad = toRad(lon);
    const lonOrigin = (zone - 1) * 6 - 180 + 3;
    const lonOriginRad = toRad(lonOrigin);

    const eccPrimeSq = UTM_ECC_SQ / (1 - UTM_ECC_SQ);
    const N = UTM_A / Math.sqrt(1 - UTM_ECC_SQ * Math.sin(latRad) ** 2);
    const T = Math.tan(latRad) ** 2;
    const C = eccPrimeSq * Math.cos(latRad) ** 2;
    const A = Math.cos(latRad) * (lonRad - lonOriginRad);

    const M = UTM_A * (
      (1 - UTM_ECC_SQ / 4 - 3 * UTM_ECC_SQ ** 2 / 64 - 5 * UTM_ECC_SQ ** 3 / 256) * latRad
      - (3 * UTM_ECC_SQ / 8 + 3 * UTM_ECC_SQ ** 2 / 32 + 45 * UTM_ECC_SQ ** 3 / 1024) * Math.sin(2 * latRad)
      + (15 * UTM_ECC_SQ ** 2 / 256 + 45 * UTM_ECC_SQ ** 3 / 1024) * Math.sin(4 * latRad)
      - (35 * UTM_ECC_SQ ** 3 / 3072) * Math.sin(6 * latRad)
    );

    const easting = UTM_K0 * N * (
      A + (1 - T + C) * A ** 3 / 6
      + (5 - 18 * T + T ** 2 + 72 * C - 58 * eccPrimeSq) * A ** 5 / 120
    ) + 500000.0;

    let northing = UTM_K0 * (
      M + N * Math.tan(latRad) * (
        A ** 2 / 2
        + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
        + (61 - 58 * T + T ** 2 + 600 * C - 330 * eccPrimeSq) * A ** 6 / 720
      )
    );
    if (lat < 0) northing += 10000000.0;

    return { zone, band, easting, northing };
  }

  function latLonToMgrs(lat, lon, precision = 5) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "---";
    try {
      const { zone, band, easting, northing } = latLonToUtm(lat, lon);
      const setIdx = (zone - 1) % 3;
      const colIdx = Math.floor(easting / 100000) - 1;
      const colLetter = SET_ORIGIN_COL[setIdx][colIdx];

      const rowSetIdx = (zone - 1) % 2;
      const rowIdx = Math.floor(northing / 100000) % 20;
      const rowLetter = SET_ORIGIN_ROW[rowSetIdx][rowIdx];

      const eRem = Math.floor(easting % 100000);
      const nRem = Math.floor(northing % 100000);
      const div = Math.pow(10, 5 - precision);

      const eStr = String(Math.floor(eRem / div)).padStart(precision, "0");
      const nStr = String(Math.floor(nRem / div)).padStart(precision, "0");

      return `${zone}${band} ${colLetter}${rowLetter} ${eStr} ${nStr}`;
    } catch (e) {
      return "FUORI RANGE";
    }
  }

  function getMinNorthing(band) {
    const bandIdx = LAT_BANDS.indexOf(band);
    if (bandIdx === -1) throw new Error("Banda MGRS non valida");
    const latMin = -80 + bandIdx * 8;
    const { northing } = latLonToUtm(latMin + 0.0001, 3);
    return northing;
  }

  function mgrsToLatLon(mgrsRaw) {
    if (!mgrsRaw || typeof mgrsRaw !== "string") throw new Error("Stringa MGRS vuota");
    const clean = mgrsRaw.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const match = clean.match(/^([0-9]{1,2})([C-HJ-NP-X])([A-HJ-NP-Z]{2})([0-9]{2,10})$/);
    if (!match) throw new Error("Formato MGRS non valido (es. 32T PP 32840 38820)");

    const zone = parseInt(match[1], 10);
    if (zone < 1 || zone > 60) throw new Error("Fuso UTM fuori range (1-60)");

    const band = match[2];
    const digraph = match[3];
    const digits = match[4];
    if (digits.length % 2 !== 0) throw new Error("Numero cifre MGRS dispari");

    const prec = digits.length / 2;
    const mult = Math.pow(10, 5 - prec);
    const eLocal = parseInt(digits.slice(0, prec), 10) * mult + mult / 2;
    const nLocal = parseInt(digits.slice(prec), 10) * mult + mult / 2;

    const setIdx = (zone - 1) % 3;
    const colIdx = SET_ORIGIN_COL[setIdx].indexOf(digraph[0]);
    if (colIdx === -1) throw new Error(`Lettera colonna ${digraph[0]} non valida per fuso ${zone}`);
    const easting = (colIdx + 1) * 100000 + eLocal;

    const rowSetIdx = (zone - 1) % 2;
    const rowIdx = SET_ORIGIN_ROW[rowSetIdx].indexOf(digraph[1]);
    if (rowIdx === -1) throw new Error(`Lettera riga ${digraph[1]} non valida per fuso ${zone}`);

    let northing = rowIdx * 100000 + nLocal;
    const minN = getMinNorthing(band);
    while (northing < minN - 100000) {
      northing += 2000000;
    }

    const isSouth = LAT_BANDS.indexOf(band) < 10;
    const y = isSouth ? northing - 10000000.0 : northing;
    const x = easting - 500000.0;

    const eccPrimeSq = UTM_ECC_SQ / (1 - UTM_ECC_SQ);
    const e1 = (1 - Math.sqrt(1 - UTM_ECC_SQ)) / (1 + Math.sqrt(1 - UTM_ECC_SQ));
    const M = y / UTM_K0;
    const mu = M / (UTM_A * (1 - UTM_ECC_SQ / 4 - 3 * UTM_ECC_SQ ** 2 / 64 - 5 * UTM_ECC_SQ ** 3 / 256));

    const phi1Rad = mu
      + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
      + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

    const N1 = UTM_A / Math.sqrt(1 - UTM_ECC_SQ * Math.sin(phi1Rad) ** 2);
    const T1 = Math.tan(phi1Rad) ** 2;
    const C1 = eccPrimeSq * Math.cos(phi1Rad) ** 2;
    const R1 = UTM_A * (1 - UTM_ECC_SQ) / Math.pow(1 - UTM_ECC_SQ * Math.sin(phi1Rad) ** 2, 1.5);
    const D = x / (N1 * UTM_K0);

    const latRad = phi1Rad - (N1 * Math.tan(phi1Rad) / R1) * (
      D ** 2 / 2
      - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * eccPrimeSq) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * eccPrimeSq - 3 * C1 ** 2) * D ** 6 / 720
    );

    const lonOrigin = (zone - 1) * 6 - 180 + 3;
    const lonRad = (
      D - (1 + 2 * T1 + C1) * D ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * eccPrimeSq + 24 * T1 ** 2) * D ** 5 / 120
    ) / Math.cos(phi1Rad);

    return {
      lat: toDeg(latRad),
      lon: lonOrigin + toDeg(lonRad)
    };
  }

  async function fetchElevationFt(lat, lon) {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Errore DEM Open-Meteo");
    const data = await res.json();
    if (data && Array.isArray(data.elevation) && typeof data.elevation[0] === "number") {
      return Math.round(data.elevation[0] * M_TO_FT);
    }
    throw new Error("Dato elevazione non disponibile");
  }

  function initPwaAutoUpdate(onInstallAvailable) {
    if ("serviceWorker" in navigator) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });

      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").then((reg) => {
          reg.update();
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
              reg.update();
            }
          });
        }).catch(() => {});
      });
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      if (typeof onInstallAvailable === "function") {
        onInstallAvailable(e);
      }
    });
  }

  return {
    R_EARTH, FT_TO_M, M_TO_FT, KT_TO_MS, MS_TO_KT,
    toRad, toDeg,
    distanceMeters, bearingDegrees, destinationPoint, crossTrackMeters,
    latLonToMgrs, mgrsToLatLon,
    fetchElevationFt,
    initPwaAutoUpdate
  };
})();
