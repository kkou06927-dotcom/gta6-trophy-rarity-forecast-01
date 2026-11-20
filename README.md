![Competition](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)
![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kkou06927-dotcom/gta6-trophy-rarity-forecast-01/rank.svg)
![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kkou06927-dotcom/gta6-trophy-rarity-forecast-01/reward.svg)

# GTA VI trophy rarity forecast

Entry for make.fun's [GTA 6 Trophy Rarity Forecast bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01): for every PlayStation 5 trophy of Grand Theft Auto VI, forecast its earn rate on Exophase at the case's target time, as five quantiles (5%, 25%, 50%, 75%, 95%).

## How it works

`node main.ts` reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes one `<id>.out` per case to `$MAKEFUN_OUTPUT_DIR` (else `/output`). Node 22, standard library only, no network, fully deterministic.

The method, in plain words:

- **Work in counts, not rates.** A trophy's printed rate is earners ÷ players tracked, and both numbers only change when Exophase refreshes the page. The read history is first collapsed into refresh snapshots — a new snapshot whenever the player count or any rate moves — and each trophy's earners are rebuilt as rate × players at every refresh.
- **Players saturate.** Tracked players grow fast at launch and then level off, so their count is fitted with a straight line against log-time, ln(1 + hours since the first snapshot), and read at the target.
- **Earners follow their own curve.** Each trophy's earners are fitted the same way — a power law in (1 + hours), least squares on ln(earners + 0.5) — so story trophies that pile up early and grind trophies that accumulate slowly each follow their own trajectory. Extrapolating in log-time damps the growth, and the result is clamped so earners can never pass the player count and the median rate stays within a sane distance of the last read. The median rate is 100 × earners ÷ players at the target.
- **Honest spread.** The five quantiles sit on the logit scale around that median. The width grows with the square root of the horizon in days and with each trophy's own observed jumpiness between refreshes; a history that has never shown a refresh gets extra width instead of false confidence, because the launch refresh is exactly what moved every rate. Trophies with too little history fall back to their last rate with the same spread machinery.
