'use client';

import { Fragment, useMemo, useState } from 'react';
import { DISPOSITION_OPTIONS, type Disposition, type ReviewOption, type ScanResultRow } from '@/types/app';
import { determineGradingLane, formatConfidencePct, formatRelativeTime, scoreDealOpportunity, summarizeDealReasons, toCurrency, toPct } from '@/lib/utils';

export function ResultsTable({
  title,
  rows,
  reviewOptionsByResultId,
  onDisposition,
  onResolveReview,
}: {
  title: string;
  rows: ScanResultRow[];
  reviewOptionsByResultId?: Record<string, ReviewOption[]>;
  onDisposition: (ids: string[], disposition: Disposition) => Promise<void>;
  onResolveReview?: (resultId: string, optionId: string) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<'createdAt' | 'estimatedMarginPct' | 'totalPurchasePrice' | 'estimatedProfit' | 'dealScore'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const scoredRows = useMemo(() => rows.map((row) => ({ row, dealScore: scoreDealOpportunity({ estimatedProfit: row.estimatedProfit, estimatedMarginPct: row.estimatedMarginPct, aiConfidence: row.aiConfidence, scpUngradedSell: row.scpUngradedSell, scpGrade9: row.scpGrade9, scpPsa10: row.scpPsa10, totalPurchasePrice: row.totalPurchasePrice, needsReview: row.needsReview, auctionEndsAt: row.auctionEndsAt }) })), [rows]);

  const sortedRows = useMemo(() => {
    const copy = [...scoredRows];
    copy.sort((a, b) => {
      const left = valueForSort(a.row, a.dealScore, sortKey);
      const right = valueForSort(b.row, b.dealScore, sortKey);
      if (left !== right) {
        return sortDir === 'asc' ? (left > right ? 1 : -1) : left < right ? 1 : -1;
      }

      if (sortKey !== 'createdAt') {
        const createdA = new Date(a.row.createdAt).getTime();
        const createdB = new Date(b.row.createdAt).getTime();
        if (createdA !== createdB) return createdB - createdA;
      }

      const marginA = a.row.estimatedMarginPct ?? -9999;
      const marginB = b.row.estimatedMarginPct ?? -9999;
      if (marginA !== marginB) return marginB - marginA;

      return new Date(b.row.createdAt).getTime() - new Date(a.row.createdAt).getTime();
    });
    return copy;
  }, [scoredRows, sortKey, sortDir]);

  function toggleSelection(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function handleBulk(disposition: Disposition) {
    if (selectedIds.length === 0) return;
    await onDisposition(selectedIds, disposition);
    setSelectedIds([]);
  }

  return (
    <div className="card card-pad stack">
      <div className="spread">
        <h2 className="section-title">{title}</h2>
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => setSelectedIds(rows.map((row) => row.id))}>Select All</button>
          {DISPOSITION_OPTIONS.slice(0, 6).map((option) => (
            <button key={option.value} className={option.tone === 'danger' ? 'btn btn-danger' : 'btn'} onClick={() => handleBulk(option.value)}>{option.label}</button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Image</th>
              <th>eBay Title</th>
              <th><button className="btn btn-ghost small" onClick={() => flipSort('dealScore', sortKey, sortDir, setSortKey, setSortDir)}>Deal Score</button></th>
              <th><button className="btn btn-ghost small" onClick={() => flipSort('totalPurchasePrice', sortKey, sortDir, setSortKey, setSortDir)}>Purchase Total</button></th>
              <th><button className="btn btn-ghost small" onClick={() => flipSort('estimatedProfit', sortKey, sortDir, setSortKey, setSortDir)}>Profit</button></th>
              <th>SCP Ungraded</th>
              <th>Grade 9</th>
              <th>PSA 10</th>
              <th>SCP</th>
              <th><button className="btn btn-ghost small" onClick={() => flipSort('createdAt', sortKey, sortDir, setSortKey, setSortDir)}>Found</button></th>
              <th>Auction Time</th>
              <th><button className="btn btn-ghost small" onClick={() => flipSort('estimatedMarginPct', sortKey, sortDir, setSortKey, setSortDir)}>Margin</button></th>
              <th>Disposition</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(({ row, dealScore }) => {
              const reviewOptions = reviewOptionsByResultId?.[row.id] ?? [];
              const gradingLane = determineGradingLane({
                totalPurchasePrice: row.totalPurchasePrice,
                scpUngradedSell: row.scpUngradedSell,
                scpGrade9: row.scpGrade9,
                scpPsa10: row.scpPsa10,
              });

              return (
                <Fragment key={row.id}>
                  <tr>
                    <td>
                      <input type="checkbox" checked={selectedIds.includes(row.id)} onChange={() => toggleSelection(row.id)} />
                    </td>
                    <td>{row.imageUrl ? <img className="table-image" src={row.imageUrl} alt={row.ebayTitle} /> : '—'}</td>
                    <td>
                      <div><a href={row.ebayUrl} target="_blank" rel="noreferrer">{row.ebayTitle}</a></div>
                      <div className="small muted">Confidence: {formatConfidencePct(row.aiConfidence)}</div>
                      {row.needsReview ? <div className="small" style={{ color: '#f6d365', fontWeight: 600 }}>Review suggested — surfaced here because it still looks profitable.</div> : null}
                      <div className="small muted">eBay total: {toCurrency(row.purchasePrice)} + {toCurrency(row.shippingPrice)} shipping = {toCurrency(row.totalPurchasePrice)}</div>
                      {row.sellerUsername ? <div className="small muted">Seller: {row.sellerUsername}{row.listingQualityScore !== null ? ` · Listing ${Math.round(row.listingQualityScore)}/100` : ''}</div> : null}
                      <div className="small" style={{ color: '#d8e1f0', marginTop: 4 }}>
                        Why it stands out: {summarizeDealReasons({
                          estimatedProfit: row.estimatedProfit,
                          estimatedMarginPct: row.estimatedMarginPct,
                          aiConfidence: row.aiConfidence,
                          scpUngradedSell: row.scpUngradedSell,
                          scpGrade9: row.scpGrade9,
                          scpPsa10: row.scpPsa10,
                          totalPurchasePrice: row.totalPurchasePrice,
                          auctionEndsAt: row.auctionEndsAt,
                          needsReview: row.needsReview,
                        }) || 'No strong edge yet'}
                      </div>
                      <div className="small muted" style={{ marginTop: 4 }}>Grade lane: {gradingLane.label} — {gradingLane.detail}</div>
                      {row.reasoning ? <div className="small muted" style={{ marginTop: 4 }}>{row.reasoning}</div> : null}
                    </td>
                    <td><span className="badge">{dealScore}</span></td>
                    <td>
                      <div>{toCurrency(row.totalPurchasePrice)}</div>
                      <div className="small muted">{toCurrency(row.purchasePrice)} + {toCurrency(row.shippingPrice)} ship</div>
                    </td>
                    <td>{toCurrency(row.estimatedProfit)}</td>
                    <td>{toCurrency(row.scpUngradedSell)}</td>
                    <td>{toCurrency(row.scpGrade9)}</td>
                    <td>{toCurrency(row.scpPsa10)}</td>
                    <td>{row.scpLink ? <a href={row.scpLink} target="_blank" rel="noreferrer">Open SCP</a> : '—'}</td>
                    <td>{new Date(row.createdAt).toLocaleString()}</td>
                    <td>
                      {row.auctionEndsAt ? (
                        <>
                          <div>{formatRelativeTime(row.auctionEndsAt)}</div>
                          <div className="small muted">{new Date(row.auctionEndsAt).toLocaleString()}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td>{toPct(row.estimatedMarginPct)}</td>
                    <td>
                      <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                        {DISPOSITION_OPTIONS.map((option) => (
                          <button key={option.value} className={option.tone === 'danger' ? 'btn btn-danger' : 'btn'} onClick={() => onDisposition([row.id], option.value)}>{option.label}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                  {row.needsReview && reviewOptions.length > 0 && onResolveReview ? (
                    <tr>
                      <td colSpan={14}>
                        <div className="deals-options-grid">
                          {reviewOptions.map((option) => (
                            <div key={option.id} className="card card-pad stack review-option-card">
                              <div className="spread" style={{ alignItems: 'flex-start' }}>
                                <div>
                                  <div className="small muted">Option {option.rank}</div>
                                  <div style={{ fontWeight: 700, lineHeight: 1.35 }}>{option.scpProductName}</div>
                                </div>
                                <div className="row-actions" style={{ gap: 6, justifyContent: 'flex-end' }}>
                                  {option.aiPreferred ? <span className="badge">AI shortlist</span> : null}
                                  {option.candidateSource ? <span className="badge">{option.candidateSource}</span> : null}
                                  {option.confidence !== null ? <span className="badge">AI {formatConfidencePct(option.confidence)}</span> : null}
                                </div>
                              </div>
                              <div className="grid grid-2" style={{ gap: 10 }}>
                                <div className="kpi">
                                  <div className="small muted">Ungraded</div>
                                  <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(option.scpUngradedSell)}</div>
                                </div>
                                <div className="kpi">
                                  <div className="small muted">Profit</div>
                                  <div className="kpi-value" style={{ fontSize: '1rem' }}>{toCurrency(option.scpUngradedSell !== null ? option.scpUngradedSell - row.totalPurchasePrice : null)}</div>
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
                              <div className="row-actions">
                                <button className="btn btn-primary" onClick={() => onResolveReview(row.id, option.id)}>{option.scpUngradedSell !== null && option.scpUngradedSell - row.totalPurchasePrice <= 0 ? 'Use this match & hide' : 'Use this match'}</button>
                                {option.scpLink ? <a href={option.scpLink} target="_blank" rel="noreferrer">Open SCP</a> : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={14} className="muted">No rows yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function valueForSort(row: ScanResultRow, dealScore: number, key: 'createdAt' | 'estimatedMarginPct' | 'totalPurchasePrice' | 'estimatedProfit' | 'dealScore'): number {
  if (key === 'createdAt') return new Date(row.createdAt).getTime();
  if (key === 'estimatedMarginPct') return row.estimatedMarginPct ?? -9999;
  if (key === 'estimatedProfit') return row.estimatedProfit ?? -9999;
  if (key === 'dealScore') return dealScore;
  return row.totalPurchasePrice;
}

function flipSort(
  nextKey: 'createdAt' | 'estimatedMarginPct' | 'totalPurchasePrice' | 'estimatedProfit' | 'dealScore',
  currentKey: 'createdAt' | 'estimatedMarginPct' | 'totalPurchasePrice' | 'estimatedProfit' | 'dealScore',
  currentDir: 'asc' | 'desc',
  setKey: (value: 'createdAt' | 'estimatedMarginPct' | 'totalPurchasePrice' | 'estimatedProfit' | 'dealScore') => void,
  setDir: (value: 'asc' | 'desc') => void,
) {
  if (currentKey === nextKey) {
    setDir(currentDir === 'asc' ? 'desc' : 'asc');
  } else {
    setKey(nextKey);
    setDir(nextKey === 'totalPurchasePrice' ? 'asc' : 'desc');
  }
}
