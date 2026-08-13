import { assessPromotion, loadRadar } from "./index.js";
import { loadUniverse } from "../universe/index.js";

// `npm run radar` — the review step between "watching" and "trading".
//
// Prints what each radar asset has actually shown, against the bar in
// universe.yaml. This is the human checkpoint the whole radar tier exists to
// serve: it tells you WHICH assets have earned a look and WHY, and then stops.
// Promotion is you editing universe.yaml — never this script.

function main(): void {
  const universe = loadUniverse();
  const store = loadRadar();

  if (!universe.radar.length) {
    console.log("No radar assets. Add some under `radar:` in universe.yaml.");
    return;
  }

  const assessments = universe.radar
    .map((a) => ({ asset: a, assessment: assessPromotion(a.symbol, store[a.symbol] ?? [], universe.promotion) }))
    // Closest to promotion first — that's the order a reviewer cares about.
    .sort((x, y) => y.assessment.score - x.assessment.score);

  console.log(`\nRADAR — ${universe.radar.length} asset(s) observed, never traded\n`);

  for (const { asset, assessment: a } of assessments) {
    const status = a.blocked ? `BLOCKED (${a.blocked})` : a.ready ? "READY FOR REVIEW" : "watching";
    console.log(`${a.asset.padEnd(8)} ${status}   ${(a.score * 100).toFixed(0)}%  (${a.observations} obs)`);
    if (asset.note) console.log(`         note: ${asset.note}`);
    for (const k of a.checks) {
      console.log(`         ${k.ok ? "✅" : "  "} ${k.name.padEnd(13)} ${k.detail}`);
    }
    console.log("");
  }

  const ready = assessments.filter((x) => x.assessment.ready).map((x) => x.asset.symbol);
  console.log(
    ready.length
      ? `${ready.join(", ")} cleared every check. Move to \`watchlist:\` in universe.yaml to trade it.`
      : "Nothing has cleared the bar yet — keep watching.",
  );
}

main();
