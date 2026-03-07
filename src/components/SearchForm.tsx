'use client';

import { useState, type FormEvent, type ChangeEvent } from 'react';
import type { SearchForm as SearchFormType } from '@/types/app';

const defaultFilters: SearchFormType = {
  sport: 'Football',
  conditionMode: 'raw',
  listingMode: 'buy_now',
  rookie: false,
  autographed: false,
  memorabilia: false,
  numberedCard: false,
  startYear: null,
  endYear: null,
  auctionHours: null,
  maxPurchasePrice: null,
  minProfit: null,
  minMarginPct: null,
};

export function SearchForm({ onStart, isBusy }: { onStart: (filters: SearchFormType) => Promise<void>; isBusy: boolean }) {
  const [filters, setFilters] = useState<SearchFormType>(defaultFilters);

  function update<K extends keyof SearchFormType>(key: K, value: SearchFormType[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onStart(filters);
  }

  return (
    <form className="card card-pad stack" onSubmit={handleSubmit}>
      <div className="spread">
        <div>
          <h2 className="section-title">Search Parameters</h2>
          <div className="muted small">Broad search by default. Add as much detail as you want.</div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={isBusy}>
          {isBusy ? 'Scan Running...' : 'Begin Scan'}
        </button>
      </div>

      <div className="grid grid-4">
        {renderText('Sport', filters.sport, (value) => update('sport', value), true)}
        {renderNumber('Starting Year', filters.startYear, (value) => update('startYear', value))}
        {renderNumber('Ending Year', filters.endYear, (value) => update('endYear', value))}
        {renderText('Card Brand', filters.brand ?? '', (value) => update('brand', value || undefined))}
        {renderText('Card Variant', filters.variant ?? '', (value) => update('variant', value || undefined))}
        {renderText('Card Insert', filters.insert ?? '', (value) => update('insert', value || undefined))}
        {renderText('Card Number', filters.cardNumber ?? '', (value) => update('cardNumber', value || undefined))}
        {renderText('Numbered out of', filters.numberedOutOf ?? '', (value) => update('numberedOutOf', value || undefined))}
        {renderText('Player Name', filters.playerName ?? '', (value) => update('playerName', value || undefined))}
        {renderText('Position', filters.position ?? '', (value) => update('position', value || undefined))}
        {renderText('Team', filters.team ?? '', (value) => update('team', value || undefined))}
        {renderNumber('Max Purchase Price', filters.maxPurchasePrice, (value) => update('maxPurchasePrice', value))}
        {renderNumber('Min Profit $', filters.minProfit, (value) => update('minProfit', value))}
        {renderNumber('Min Margin %', filters.minMarginPct, (value) => update('minMarginPct', value))}
      </div>

      <div className="grid grid-3">
        <div>
          <label className="label">Flags</label>
          <div className="checkbox-row">
            {renderCheckbox('Rookie', filters.rookie ?? false, (v) => update('rookie', v))}
            {renderCheckbox('Autographed', filters.autographed ?? false, (v) => update('autographed', v))}
            {renderCheckbox('Memorabilia', filters.memorabilia ?? false, (v) => update('memorabilia', v))}
            {renderCheckbox('Numbered Card', filters.numberedCard ?? false, (v) => update('numberedCard', v))}
          </div>
        </div>
        <div>
          <label className="label">Raw / Graded</label>
          <div className="radio-row">
            {renderRadio('conditionMode', 'raw', filters.conditionMode, (v) => update('conditionMode', v))}
            {renderRadio('conditionMode', 'graded', filters.conditionMode, (v) => update('conditionMode', v))}
            {renderRadio('conditionMode', 'any', filters.conditionMode, (v) => update('conditionMode', v))}
          </div>
        </div>
        <div>
          <label className="label">Listing Type</label>
          <div className="stack">
            <div className="radio-row">
              {renderRadio('listingMode', 'buy_now', filters.listingMode, (v) => update('listingMode', v))}
              {renderRadio('listingMode', 'auction', filters.listingMode, (v) => update('listingMode', v))}
            </div>
            <select
              className="select"
              disabled={filters.listingMode !== 'auction'}
              value={filters.auctionHours ?? ''}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => update('auctionHours', event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Auction ending window</option>
              <option value="1">1 hour</option>
              <option value="2">2 hours</option>
              <option value="4">4 hours</option>
              <option value="6">6 hours</option>
            </select>
          </div>
        </div>
      </div>
    </form>
  );
}

function renderText(label: string, value: string, onChange: (value: string) => void, required = false) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" value={value} required={required} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />
    </div>
  );
}

function renderNumber(label: string, value: number | null | undefined, onChange: (value: number | null) => void) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type="number"
        value={value ?? ''}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value ? Number(event.target.value) : null)}
      />
    </div>
  );
}

function renderCheckbox(label: string, checked: boolean, onChange: (value: boolean) => void) {
  return (
    <label className="badge">
      <input type="checkbox" checked={checked} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} style={{ marginRight: 8 }} />
      {label}
    </label>
  );
}

function renderRadio<T extends string>(name: string, value: T, selected: T, onChange: (value: T) => void) {
  return (
    <label className="badge">
      <input type="radio" name={name} checked={selected === value} onChange={() => onChange(value)} style={{ marginRight: 8 }} />
      {value.replace('_', ' ')}
    </label>
  );
}
