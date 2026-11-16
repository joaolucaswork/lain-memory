import { describe, expect, test } from 'bun:test';
import { scoreImportance, shouldApplyHeuristicState } from './mem0.js';

// Tarefa D item 2 — scoreImportance sem bônus de projeto/fornecedor.
// Cada texto isola UM sinal (sem dígitos, datas ou palavras-gatilho extras)
// para não haver interferência entre regex.

describe('scoreImportance — sem bônus de projeto/fornecedor', () => {
  test('base neutra sem nenhum sinal', () => {
    expect(scoreImportance('o usuário viu uma banana')).toBe(0.2);
  });

  test('nomes próprios e fornecedores não pontuam', () => {
    expect(scoreImportance('o Lucas chegou')).toBe(0.2);
    expect(scoreImportance('a Lain é grande')).toBe(0.2);
    expect(scoreImportance(
      'o usuário usa WhatsApp e Stripe com Supabase no Qdrant via Vercel com OpenAI e Claude da Anthropic no reino capital kapso Lain com Lucas',
    )).toBe(0.2);
  });
});

describe('scoreImportance — genéricos mantidos', () => {
  test('data e valor monetário', () => {
    expect(scoreImportance('o usuário marcou algo para 12/03/2026')).toBe(0.3);
    expect(scoreImportance('o usuário pagou R$ 150 pela conta')).toBe(0.3);
  });

  test('linguagem de decisão PT', () => {
    // .35 arredonda para 0.4 (Math.round(3.5) = 4)
    expect(scoreImportance('o usuário decidiu sair mais cedo')).toBe(0.4);
    expect(scoreImportance('o usuário vai usar o outro quarto')).toBe(0.4);
  });

  test('erro e incidente', () => {
    expect(scoreImportance('o usuário relatou um erro estranho')).toBe(0.3);
    expect(scoreImportance('o usuário descreveu um incidente chato')).toBe(0.3);
  });

  test('crítico e decisão EN intactos', () => {
    expect(scoreImportance('o servidor caiu de novo')).toBe(0.4);
    expect(scoreImportance('o usuário implemented the change')).toBe(0.4);
  });
});

describe('shouldApplyHeuristicState — guarda do chatAtom', () => {
  test('chatAtom:true pula heurísticas; resto aplica', () => {
    expect(shouldApplyHeuristicState({ chatAtom: true })).toBe(false);
    expect(shouldApplyHeuristicState(undefined)).toBe(true);
    expect(shouldApplyHeuristicState({})).toBe(true);
    expect(shouldApplyHeuristicState({ chatAtom: false })).toBe(true);
    expect(shouldApplyHeuristicState({ inferFalse: true })).toBe(true);
  });
});
