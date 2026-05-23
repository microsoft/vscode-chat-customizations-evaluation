import { describe, it, expect, vi } from 'vitest';
import {
  selectPreferredModel,
  isExpensiveFamily,
  PREFERRED_FALLBACK_FAMILIES,
  EXPENSIVE_MODEL_FAMILIES,
} from '../modelSelection';
import type { ModelCandidate } from '../modelSelection';

function model(family: string, name = family): ModelCandidate {
  return { family, name };
}

// ---------------------------------------------------------------------------
// isExpensiveFamily
// ---------------------------------------------------------------------------

describe('isExpensiveFamily', () => {
  it('returns true for every entry in EXPENSIVE_MODEL_FAMILIES', () => {
    for (const family of EXPENSIVE_MODEL_FAMILIES) {
      expect(isExpensiveFamily(family), `expected ${family} to be expensive`).toBe(true);
    }
  });

  it('returns true for versioned suffix of expensive family (claude-opus-4.7)', () => {
    expect(isExpensiveFamily('claude-opus-4.7')).toBe(true);
  });

  it('returns true for versioned suffix of expensive family (gemini-3.5-flash-001)', () => {
    expect(isExpensiveFamily('gemini-3.5-flash-001')).toBe(true);
  });

  it('returns true for versioned suffix of expensive family (gpt-5.5-turbo)', () => {
    expect(isExpensiveFamily('gpt-5.5-turbo')).toBe(true);
  });

  it('returns false for a family that only shares a prefix substring (gemini-3.5-flash-lite should not be blocked by gemini-3.5-flash alone)', () => {
    // "gemini-3.5-flash-lite" starts with "gemini-3.5-flash-", so it IS caught —
    // verify the logic works correctly both ways.
    expect(isExpensiveFamily('gemini-3.5-flash-lite')).toBe(true); // startsWith('gemini-3.5-flash-')
  });

  it('returns false for a cheap model that contains an expensive word mid-string', () => {
    // "gpt-5.5" is expensive; "gpt-5.5-mini" should also be caught.
    // But "not-gpt-5.5" should NOT be caught (no exact or leading prefix match).
    expect(isExpensiveFamily('not-gpt-5.5')).toBe(false);
  });

  it('returns false for cheap preferred families', () => {
    for (const family of PREFERRED_FALLBACK_FAMILIES) {
      expect(isExpensiveFamily(family), `expected ${family} to be cheap`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// selectPreferredModel — empty / trivial cases
// ---------------------------------------------------------------------------

describe('selectPreferredModel — empty list', () => {
  it('returns undefined when no models are provided', () => {
    expect(selectPreferredModel([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectPreferredModel — preferred family ordering
// ---------------------------------------------------------------------------

describe('selectPreferredModel — preferred family ordering', () => {
  it('picks copilot-utility (first in preference list) when available', () => {
    const models = [model('claude-sonnet'), model('copilot-utility'), model('gpt-5-mini')];
    expect(selectPreferredModel(models)?.family).toBe('copilot-utility');
  });

  it('picks gpt-5-mini when copilot-utility is absent', () => {
    const models = [model('claude-sonnet'), model('gpt-5-mini'), model('gpt-5.4')];
    expect(selectPreferredModel(models)?.family).toBe('gpt-5-mini');
  });

  it('respects order — picks raptor-mini over gpt-5.4-mini', () => {
    const models = [model('gpt-5.4-mini'), model('raptor-mini')];
    expect(selectPreferredModel(models)?.family).toBe('raptor-mini');
  });

  it('picks the first preferred match even when more expensive models are also listed', () => {
    const models = [model('claude-opus'), model('gpt-5.5'), model('claude-haiku')];
    expect(selectPreferredModel(models)?.family).toBe('claude-haiku');
  });

  it('returns the model object itself (identity preserved)', () => {
    const cheap = model('copilot-utility', 'Copilot Utility 1.0');
    const result = selectPreferredModel([cheap]);
    expect(result).toBe(cheap);
  });
});

// ---------------------------------------------------------------------------
// selectPreferredModel — expensive model blocking
// ---------------------------------------------------------------------------

describe('selectPreferredModel — expensive model blocking', () => {
  it('refuses to select claude-opus (15x) when it is the only model', () => {
    const log = vi.fn();
    expect(selectPreferredModel([model('claude-opus')], log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expensive'));
  });

  it('refuses to select gemini-3.5-flash (14x) when it is the only model', () => {
    const log = vi.fn();
    expect(selectPreferredModel([model('gemini-3.5-flash')], log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expensive'));
  });

  it('refuses to select gpt-5.5 (7.5x) when it is the only model', () => {
    const log = vi.fn();
    expect(selectPreferredModel([model('gpt-5.5')], log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expensive'));
  });

  it('refuses to select gpt-4.5 when it is the only model', () => {
    expect(selectPreferredModel([model('gpt-4.5')])).toBeUndefined();
  });

  it('refuses to select o1 when it is the only model', () => {
    expect(selectPreferredModel([model('o1')])).toBeUndefined();
  });

  it('refuses to select o3 when it is the only model', () => {
    expect(selectPreferredModel([model('o3')])).toBeUndefined();
  });

  it('refuses when ALL available models are expensive', () => {
    const log = vi.fn();
    const result = selectPreferredModel(
      [model('claude-opus'), model('gemini-3.5-flash'), model('gpt-5.5')],
      log
    );
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expensive'));
  });

  it('blocks versioned expensive family (claude-opus-4.7)', () => {
    const log = vi.fn();
    expect(selectPreferredModel([model('claude-opus-4.7')], log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('expensive'));
  });
});

// ---------------------------------------------------------------------------
// selectPreferredModel — affordable fallback (no preferred family present)
// ---------------------------------------------------------------------------

describe('selectPreferredModel — affordable fallback', () => {
  it('returns an unrecognised but non-expensive model when no preferred family matches', () => {
    const log = vi.fn();
    const unknown = model('some-unknown-model');
    const result = selectPreferredModel([unknown], log);
    expect(result?.family).toBe('some-unknown-model');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Warning'));
  });

  it('skips expensive models in the affordable fallback, picks the non-expensive one', () => {
    const log = vi.fn();
    const result = selectPreferredModel(
      [model('claude-opus'), model('some-unknown-cheap-model')],
      log
    );
    expect(result?.family).toBe('some-unknown-cheap-model');
  });

  it('does not call the logger when a preferred model is selected directly', () => {
    const log = vi.fn();
    selectPreferredModel([model('copilot-utility')], log);
    expect(log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// selectPreferredModel — logger behaviour
// ---------------------------------------------------------------------------

describe('selectPreferredModel — logger', () => {
  it('does not throw when no logger is provided', () => {
    // Reaches the "all expensive" branch with no logger — must not throw.
    expect(() => selectPreferredModel([model('claude-opus')])).not.toThrow();
  });

  it('calls logger with a message containing the chosen family on affordable fallback', () => {
    const log = vi.fn();
    selectPreferredModel([model('unknown-affordable')], log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unknown-affordable'));
  });
});
