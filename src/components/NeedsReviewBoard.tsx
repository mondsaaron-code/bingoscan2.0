'use client';

import type { Disposition, ReviewOption, ScanResultRow } from '@/types/app';
import { determineGradingLane, formatRelativeTime, scoreDealOpportunity, summarizeDealReasons, toCurrency, toPct } from '@/lib/utils';

export function NeedsReviewBoard({
  rows,
  reviewOptionsByResultId,
  onResolveReview,
  onDisposition,
}: {
  rows: ScanResultRow[];
  reviewOptionsByResultId: Record<string, ReviewOption[]>;
  onResolveReview: (resultId: string, optionId: string) => Promise<void>;
  onDisposition: (ids: string[], disposition: Disposition) => Promise<void>;
}) {
  const totalOptions = rows.reduce((sum, row) => sum + (reviewOptionsByResultId[row.id]?.length ?? 0), 0);

  return (
    <div className="card card-pad stack">
      <div className="spread">
        <div>
          <h2 className="section-title">Needs Review</h2>
          <div className="muted small">Side-by-side SCP comparison for uncertain matches. Pick the correct card, suppress the listing, or mark the logic as bad.</div>
        </div>
        <div className="row-actions">
          <div className="badge">{rows.length} listings</div>
          <div className="badge">{totalOptions} candidate options</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="muted small">No listings are waiting for review.</div>
      ) : (
        <div className="stack">
          {rows.map((row) => {
            const options = reviewOptionsByResultId[row.id] ?? [];
            const score = scoreDealOpportunity({
              estimatedProfit: row.estimatedProfit,
              estimatedMarginPct: row.estimatedMarginPct,
              aiConfidence: row.aiConfidence,
              scpUngradedSell: row.scpUngradedSell,
              scpGrade9: row.scpGrade9,
              scpPsa10: row.scpPsa10,
              totalPurchasePrice: row.totalPurchasePrice,
              needsReview: true,
              auctionEndsAt: row.auctionEndsAt,
            });

            const gradingLane = determineGradingLane({
              totalPurchasePrice: row.totalPurchasePrice,
              scpUngradedSell: row.scpUngradedSell,
              scpGrade9: row.scpGrade9,
              scpPsa10: row.scpPsa10,
            });

            return (
              <div key={row.id} className="review-card">
                <div className="review-source card">
                  <div className="review-source-top">
                    {row.imageUrl ? <img className="review-image" src={row.imageUrl} alt={row.ebayTitle} /> : <div className="review-image review-placeholder">No image</div>}
                    <div className="stack" style={{ gap: 10 }}>
                      <div className="row-actions">
                        <span className="badge">AI {row.aiConfidence ? `${row.aiConfidence}%` : '—'}</span>
                        <span className="badge">Deal Score {score}</span>
                        {row.auctionEndsAt ? <span className="badge">{formatRelativeTime(row.auctionEndsAt)}</span> : null}
                      </div>
                      <div>
                        <a href={row.ebayUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>{row.ebayTitle}</a>
                      </div>
                      <div className="grid grid-3" style={{ gap: 10 }}>
                        <div className="kpi">
                          <div className="small muted">Purchase Total</div>
                          <div className="kpi-value" style={{ fontSize: '1.15rem' }}>{toCurrency(row.totalPurchasePrice)}</div>
                        </div>
                        <div className="kpi">
                          <div className="small muted">Estimated Profit</div>
                          <div className="kpi-value" style={{ fontSize: '1.15rem' }}>{toCurrency(row.estimatedProfit)}</div>
                        </div>
                        <div className="kpi">
                          <div className="small muted">Margin</div>
                          <div className="kpi-value" style={{ fontSize: '1.15rem' }}>{toPct(row.estimatedMarginPct)}</div>
                        </div>
                      </div>
                      <div className="small" style={{ color: '#d8e1f0' }}>
                        Review focus: {summarizeDealReasons({
                          estimatedProfit: row.estimatedProfit,
                          estimatedMarginPct: row.estimatedMarginPct,
                          aiConfidence: row.aiConfidence,
                          scpUngradedSell: row.scpUngradedSell,
                          scpGrade9: row.scpGrade9,
                          scpPsa10: row.scpPsa10,
                          totalPurchasePrice: row.totalPurchasePrice,
                          auctionEndsAt: row.auctionEndsAt,
                          needsReview: true,
                        }) || 'Compare the SCP candidates below.'}
                      </div>
                      <div className="small muted">Current placeholder match: Ungraded {toCurrency(row.scpUngradedSell)} · Grade 9 {toCurrency(row.scpGrade9)} · PSA 10 {toCurrency(row.scpPsa10)}</div>
                      <div className="small muted">Grade lane: {gradingLane.label} — {gradingLane.detail}</div>
                      {row.reasoning ? <div className="notice"><div className="small"><strong>AI review note:</strong> {row.reasoning}</div></div> : null}
                      <div className="row-actions">
                        <button className="btn btn-ghost" onClick={() => onDisposition([row.id], 'suppress_90_days')}>Suppress 90 Days</button>
                        <button className="btn btn-danger" onClick={() => onDisposition([row.id], 'bad_logic')}>Bad Logic</button>
                        <button className="btn" onClick={() => onDisposition([row.id], 'purchased')}>Purchased</button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="review-options-grid">
                  {options.map((option) => {
                    const profit = option.scpUngradedSell !== null ? option.scpUngradedSell - row.totalPurchasePrice : null;
                    const margin = option.scpUngradedSell !== null && row.totalPurchasePrice > 0 ? ((option.scpUngradedSell - row.totalPurchasePrice) / row.totalPurchasePrice) * 100 : null;
                    const grade9Upside = option.scpGrade9 !== null ? option.scpGrade9 - row.totalPurchasePrice : null;
                    const psa10Upside = option.scpPsa10 !== null ? option.scpPsa10 - row.totalPurchasePrice : null;

                    const optionLane = determineGradingLane({
                      totalPurchasePrice: row.totalPurchasePrice,
                      scpUngradedSell: option.scpUngradedSell,
                      scpGrade9: option.scpGrade9,
                      scpPsa10: option.scpPsa10,
                    });

                    return (
                      <div key={option.id} className="card card-pad stack review-option-card">
                        <div className="spread" style={{ alignItems: 'flex-start' }}>
                          <div>
                            <div className="small muted">Option {option.rank}</div>
                            <div style={{ fontWeight: 700, lineHeight: 1.35 }}>{option.scpProductName}</div>
                          </div>
                          {option.confidence !== null ? <span className="badge">AI {option.confidence}%</span> : null}
                        </div>
                        <div className="grid grid-2" style={{ gap: 10 }}>
                          <div className="kpi">
                            <div className="small muted">Ungraded</div>
                            <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(option.scpUngradedSell)}</div>
                          </div>
                          <div className="kpi">
                            <div className="small muted">Profit</div>
                            <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(profit)}</div>
                          </div>
                          <div className="kpi">
                            <div className="small muted">Grade 9</div>
                            <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(option.scpGrade9)}</div>
                          </div>
                          <div className="kpi">
                            <div className="small muted">PSA 10</div>
                            <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(option.scpPsa10)}</div>
                          </div>
                        </div>
                        <div className="small muted">Margin {toPct(margin)} · Grade 9 upside {toCurrency(grade9Upside)} · PSA 10 upside {toCurrency(psa10Upside)}</div>
                        <div className="small muted">Grade lane: {optionLane.label} — {optionLane.detail}</div>
                        <div className="row-actions">
                          <button className="btn btn-primary" onClick={() => onResolveReview(row.id, option.id)}>Use This Match</button>
                          {option.scpLink ? <a className="btn btn-ghost" href={option.scpLink} target="_blank" rel="noreferrer">Open SCP</a> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
