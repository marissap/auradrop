/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { GeoTarget } from "./geotarget";
import { AuraDropAgent } from "./agent";

export { GeoTarget, AuraDropAgent };

function encodeGeohash(lat: number, lng: number, precision = 5): string {
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let idx = 0, bit = 0, evenBit = true, geohash = "";
  let [latMin, latMax, lngMin, lngMax] = [-90, 90, -180, 180];
  while (geohash.length < precision) {
    if (evenBit) {
      const m = (lngMin + lngMax) / 2;
      lng >= m ? (idx = idx * 2 + 1, lngMin = m) : (idx *= 2, lngMax = m);
    } else {
      const m = (latMin + latMax) / 2;
      lat >= m ? (idx = idx * 2 + 1, latMin = m) : (idx *= 2, latMax = m);
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // GET /cell?lat=51.5&lng=-0.09
    if (url.pathname === "/cell") {
      console.log("hitting cell route, upgrade header:", req.headers.get("Upgrade"))
      const lat = parseFloat(url.searchParams.get("lat") ?? "0");
      const lng = parseFloat(url.searchParams.get("lng") ?? "0");
      const geohash = encodeGeohash(lat, lng);
      const cell = env.GEO_TARGET.get(env.GEO_TARGET.idFromName(geohash));
      return cell.fetch(req);
    }

    // GET /agent/a3f2b1c9 (WebSocket) or POST /agent/a3f2b1c9/upload
    const agentMatch = url.pathname.match(/^\/agent\/([a-f0-9]+)(\/.*)?$/);
    if (agentMatch) {
      const [, agentId, subpath] = agentMatch;
      const agent = env.AURA_AGENT.get(env.AURA_AGENT.idFromName(agentId));
      const newUrl = new URL(req.url);
      newUrl.pathname = subpath || "/";
      return agent.fetch(new Request(newUrl, req));
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;