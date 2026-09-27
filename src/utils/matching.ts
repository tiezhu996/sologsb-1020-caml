import type { ArchiveRecord, FieldKey, MatchCandidate } from '../types';

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title * .3 + fieldScores.date * .2 + fieldScores.people * .2 + fieldScores.places * .14 + fieldScores.identifier * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

interface ScoredPair {
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  reasons: string[];
}

const pairKey = (leftId: string, rightId: string) => `${leftId}::${rightId}`;

const scoreAllPairs = (records: ArchiveRecord[], skip: (leftId: string, rightId: string) => boolean): ScoredPair[] => {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const pairs: ScoredPair[] = [];
  left.forEach((a) => {
    right.forEach((b) => {
      if (skip(a.id, b.id)) return;
      const scored = scorePair(a, b);
      if (scored.score >= .38) pairs.push({ leftId: a.id, rightId: b.id, ...scored });
    });
  });
  return pairs;
};

// 按分数从高到低贪心配对，一份记录只进入一条候选
const assignOneToOne = (pairs: ScoredPair[]): ScoredPair[] => {
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  return [...pairs].sort((x, y) => y.score - x.score).filter((pair) => {
    if (usedLeft.has(pair.leftId) || usedRight.has(pair.rightId)) return false;
    usedLeft.add(pair.leftId);
    usedRight.add(pair.rightId);
    return true;
  });
};

const toCandidate = (pair: ScoredPair): MatchCandidate => ({
  id: `match-${pair.leftId}-${pair.rightId}`,
  leftId: pair.leftId,
  rightId: pair.rightId,
  score: pair.score,
  fieldScores: pair.fieldScores,
  status: 'suggested',
  reasons: pair.reasons
});

export function computeMatches(records: ArchiveRecord[]): MatchCandidate[] {
  return rematch(records, []);
}

export function rematch(records: ArchiveRecord[], previous: MatchCandidate[]): MatchCandidate[] {
  // 已有结论（确认 / 忽略 / 合并）的记录对原样保留，重新匹配后状态不变
  const decided = previous.filter((match) => match.status !== 'suggested');
  const decidedKeys = new Set(decided.map((match) => pairKey(match.leftId, match.rightId)));
  // 已确认、已合并的记录不再参与新的配对；已忽略的只是这一对不成立，记录仍可与其他记录配对
  const lockedIds = new Set<string>();
  decided.forEach((match) => {
    if (match.status === 'confirmed' || match.status === 'merged') {
      lockedIds.add(match.leftId);
      lockedIds.add(match.rightId);
    }
  });
  const pairs = scoreAllPairs(records, (leftId, rightId) =>
    lockedIds.has(leftId) || lockedIds.has(rightId) || decidedKeys.has(pairKey(leftId, rightId)));
  const suggested = assignOneToOne(pairs).map(toCandidate);
  return [...suggested, ...decided].sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
