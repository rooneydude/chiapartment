import { createServer, type Server } from "node:http";

/**
 * A stand-in leasing site.
 *
 * It reproduces the structure the real Chicago sites use — a homepage that
 * carries no availability, a /floorplans hub a click away, a unit table plus
 * the same data embedded as JSON, and floor-plan images — so the crawl,
 * adapter selection, persistence and refresh paths are genuinely exercised
 * rather than mocked.
 *
 * `round` changes the data the way a real site changes between scrapes: rents
 * drift, some units lease, others come to market.
 */

export interface FixtureUnit {
  unitNumber: string;
  floorPlanName: string;
  beds: number;
  baths: number;
  sqft: number;
  rent: number;
  availableDate: string;
}

const PLANS: Array<[string, string, number, number, number, number]> = [
  // line, plan, beds, baths, sqft, base rent
  ["01", "Studio A", 0, 1, 528, 1850],
  ["02", "One Bed A", 1, 1, 712, 2260],
  ["03", "One Bed B", 1, 1, 749, 2330],
  ["04", "Two Bed Corner", 2, 2, 1160, 3420],
  ["06", "Studio B", 0, 1, 505, 1795],
  ["08", "Two Bed Corner", 2, 2, 1224, 3550],
];

export function fixtureUnits(round: number): FixtureUnit[] {
  const out: FixtureUnit[] = [];
  let seed = 7 + round * 31;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  for (let floor = 4; floor <= 32; floor++) {
    if (floor === 13) continue; // The building skips 13.
    for (const [line, plan, beds, baths, sqft, base] of PLANS) {
      if (rand() >= 0.16) continue;
      out.push({
        unitNumber: `${floor}${line}`,
        floorPlanName: plan,
        beds,
        baths,
        sqft,
        rent:
          base +
          (floor - 4) * 20 +
          (round === 1 ? 0 : -75) +
          Math.round(rand() * 60),
        availableDate: `2026-0${round === 1 ? 9 : 8}-${String(
          1 + Math.floor(rand() * 27),
        ).padStart(2, "0")}`,
      });
    }
  }
  return out;
}

const JSON_LD = {
  "@type": "ApartmentComplex",
  name: "Fixture Residences",
  address: {
    streetAddress: "500 N Fixture St",
    addressLocality: "Chicago",
    addressRegion: "IL",
  },
  geo: { latitude: 41.8921, longitude: -87.6338 },
};

function page(title: string, body: string, json?: unknown): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} | Fixture Residences</title>
<script type="application/ld+json">${JSON.stringify(JSON_LD)}</script>
</head><body>
<nav><a href="/">Home</a> <a href="/floorplans">Floor Plans</a> <a href="/amenities">Amenities</a></nav>
${body}
${json ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json)}</script>` : ""}
</body></html>`;
}

export interface FixtureSite {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Start the fixture on `port`, or an ephemeral port when 0. */
export function startFixtureSite(
  opts: { port?: number; round?: number } = {},
): Promise<FixtureSite> {
  const round = opts.round ?? 1;
  const listed = fixtureUnits(round);

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /admin\nCrawl-delay: 0\n");
      return;
    }

    // The homepage deliberately carries no availability, so the crawler has to
    // find its way to /floorplans — which is the real-world case.
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        page(
          "Fixture Residences",
          `<h1>Fixture Residences</h1><p>Now leasing in River North.</p>
           <a href="/floorplans">See floor plans &amp; availability</a>`,
        ),
      );
      return;
    }

    if (path === "/floorplans") {
      const rows = listed
        .map(
          (u) => `<tr><td>${u.unitNumber}</td><td>${u.floorPlanName}</td><td>${u.beds}</td>
            <td>${u.baths}</td><td>${u.sqft.toLocaleString()}</td>
            <td>$${u.rent.toLocaleString()}</td><td>${u.availableDate}</td></tr>`,
        )
        .join("\n");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        page(
          "Floor Plans",
          `<h1>Availability</h1>
           <table>
             <thead><tr><th>Unit</th><th>Floor Plan</th><th>Beds</th><th>Baths</th>
               <th>Sq Ft</th><th>Rent</th><th>Available</th></tr></thead>
             <tbody>${rows}</tbody>
           </table>
           <div class="plans">
             <figure><img src="/media/studio-a-floorplan.png" alt="Studio A Floor Plan"><figcaption>Studio A · 0 Bed · 528 sq ft</figcaption></figure>
             <figure><img src="/media/two-bed-corner-floorplan.png" alt="Two Bed Corner Floor Plan"><figcaption>Two Bed Corner · 2 Bed · 1,160 sq ft</figcaption></figure>
           </div>`,
          { props: { pageProps: { availability: listed } } },
        ),
      );
      return;
    }

    if (path.startsWith("/media/")) {
      // A 1x1 PNG is enough to exercise the image download path.
      res.writeHead(200, { "content-type": "image/png" });
      res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body>Not found</body></html>");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
