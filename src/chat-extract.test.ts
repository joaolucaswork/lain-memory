import { describe, expect, test } from 'bun:test';
import {
  acceptChatFact,
  ASSISTANT_VOICE,
  buildChatExtractPrompt,
  buildFactRatingPrompt,
  buildTitlePrompt,
  CHAT_FACT_RATING_CRITERIA,
  extractChatFacts,
  EXTRACT_EXAMPLES,
  fallbackTitleFromFact,
  isTitleCandidate,
  normalizeChatFacts,
  normalizeChatFactPairs,
  normalizeChatTitle,
  rateChatFact,
  relevanceToImportance,
  rememberChatTurn,
  renderExamples,
  sanitizeChatRating,
  TITLE_IDEAL_WORDS,
} from './chat-extract.js';
import { detectLanguageHint } from './mem0/write.js';

/** Cards that recall actually stored from the 2026-11-14 Seinfeld turn. */
const ASSISTANT_FESTIVUS =
  'Na conversa de 14 de novembro de 2026, o assistente comentou que, em Seinfeld, os episódios que mais ficam gravados na memória são os de conceito absurdo — Festivus (feriado do Frank Costanza, com o \'Airing of Grievances\'), o do pote de sopas (\'No soup for you!\'), o do contest e o do marinheiro — enquanto os episódios quietos de Jerry e George conversando no café são o coração da série.';

const ASSISTANT_PARKING =
  'O episódio da vaga de estacionamento de Seinfeld (\'The Parking Space\') acontece inteiro em dois lugares — o apartamento, com todo mundo assistindo à luta, e a rua, com George e o Mike discutindo quem chegou primeiro — e acaba sem revelar quem venceu a luta, segundo o assistente.';

const ASSISTANT_HINGE =
  'Segundo o assistente, os dois episódios citados pelo usuário ficam na emenda entre a 3ª e a 4ª temporada de Seinfeld.';

const PLOT_NO_SPEAKER =
  'The Parking Space acaba sem revelar quem venceu a luta e é um cliffhanger.';

const USER_COMFORT =
  'O usuário tem Seinfeld como série conforto: já assistiu todos os episódios e continua reassistindo porque acha a série comfy.';

const USER_MARKED =
  'O usuário, reassistindo Seinfeld em ordem, disse que os episódios que mais o marcaram foram a vaga do George e o Kramer indo para LA.';

describe('acceptChatFact', () => {
  test('Seinfeld: fala do modelo não entra, fato do usuário entra', () => {
    expect(acceptChatFact(ASSISTANT_FESTIVUS)).toBe(false);
    expect(acceptChatFact(ASSISTANT_PARKING)).toBe(false);
    expect(acceptChatFact(ASSISTANT_HINGE)).toBe(false);
    expect(acceptChatFact(PLOT_NO_SPEAKER)).toBe(false);
    expect(acceptChatFact('sim')).toBe(false);
    expect(acceptChatFact(USER_COMFORT)).toBe(true);
    expect(acceptChatFact(USER_MARKED)).toBe(true);
  });

  test('voz do assistente perde mesmo quando a frase também cita o usuário', () => {
    expect(acceptChatFact(ASSISTANT_HINGE)).toBe(false);
    expect(ASSISTANT_HINGE.toLowerCase()).toContain('usuário');
  });
});

describe('extractChatFacts', () => {
  test('Seinfeld: o extrator pode devolver o bloco do modelo; a gente descarta', async () => {
    const facts = await extractChatFacts(
      {
        user: 'to revendo seinfeld em ordem, os que mais me marcaram foram a vaga e o kramer indo pra LA kkkkk',
        assistant: 'Festivus, No soup for you, The Parking Space acaba sem vencedor, dobradiça da série...',
        date: '2026-11-14',
      },
      async () => ({ facts: [ASSISTANT_FESTIVUS, ASSISTANT_PARKING, ASSISTANT_HINGE, PLOT_NO_SPEAKER, USER_MARKED] }),
    );
    expect(facts).toEqual([{ text: USER_MARKED, title: 'Reassistindo Seinfeld em ordem disse', relevance: 3, kind: 'fact', sensitive: false }]);
  });

  test('aceita o formato novo {text,title} e normaliza o título', async () => {
    const facts = await extractChatFacts(
      { user: 'to revendo seinfeld', date: '2026-11-14' },
      async () => ({ facts: [{ text: USER_MARKED, title: 'O usuário curtiu a vaga do George.' }] }),
    );
    expect(facts).toEqual([{ text: USER_MARKED, title: 'Curtiu a vaga do George', relevance: 3, kind: 'fact', sensitive: false }]);
  });

  test('lista vazia quando o modelo só falou', async () => {
    const facts = await extractChatFacts(
      { user: 'kkkkk', assistant: ASSISTANT_FESTIVUS },
      async () => ({ facts: [ASSISTANT_FESTIVUS, ASSISTANT_PARKING] }),
    );
    expect(facts).toEqual([]);
  });

  test('não chama o modelo se a pessoa não falou', async () => {
    let called = false;
    const facts = await extractChatFacts({ user: '   ' }, async () => {
      called = true;
      return { facts: [USER_COMFORT] };
    });
    expect(called).toBe(false);
    expect(facts).toEqual([]);
  });

  test('o prompt separa os papéis e proíbe a fala do assistente', () => {
    const prompt = buildChatExtractPrompt({
      user: 'me marcou a vaga',
      assistant: 'The Parking Space acaba sem vencedor',
      date: '2026-11-14',
    });
    expect(prompt).toContain('A fala do assistente não é fato');
    expect(prompt).toContain('PESSOA:\nme marcou a vaga');
    expect(prompt).toContain('ASSISTENTE:\nThe Parking Space acaba sem vencedor');
    expect(prompt).not.toContain('mode: bundle');
  });

  test('o prompt pede {text,title,relevance,kind,sensitive} com teto de 6 palavras', () => {
    const prompt = buildChatExtractPrompt({ user: 'tomo sertralina', date: '2026-11-14' });
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('máximo 6');
    expect(prompt).toContain('Sem "o usuário"');
    expect(prompt).toContain('{"facts":[{"text":"...","title":"...","relevance":3,"kind":"fact","sensitive":false}]}');
  });
});

describe('normalizeChatFactPairs', () => {
  test('aceita objetos e strings legadas, corta em 5 e deduplica', () => {
    const pairs = normalizeChatFactPairs([
      { text: USER_COMFORT, title: 'Seinfeld série conforto' },
      USER_COMFORT.toLowerCase(),
      { text: USER_MARKED, title: '' },
      { text: 'O usuário prefere chá.', title: 'prefere chá' },
      'O usuário dorme tarde.',
      { text: 'not a fact', title: 'x' },
      'O usuário gosta de banana assada.',
      'O usuário guarda a janta para o café.',
    ]);
    expect(pairs).toHaveLength(5);
    expect(pairs[0]).toEqual({ text: USER_COMFORT, title: 'Seinfeld série conforto', relevance: 3, kind: 'fact', sensitive: false });
    // título vazio cai no fallback do corpo
    expect(pairs[1]).toEqual({ text: USER_MARKED, title: 'Reassistindo Seinfeld em ordem disse', relevance: 3, kind: 'fact', sensitive: false });
    expect(pairs[3]).toEqual({ text: 'O usuário dorme tarde.', title: 'Dorme tarde', relevance: 3, kind: 'fact', sensitive: false });
  });
});

describe('EXTRACT_EXAMPLES — exemplos como dados sintéticos', () => {
  test('nenhum exemplo é rejeitado pelo próprio pipeline', () => {
    for (const ex of EXTRACT_EXAMPLES) {
      const out = normalizeChatFactPairs(ex.facts);
      expect(out.map((f) => f.text)).toEqual(ex.facts.map((f) => f.text));
    }
  });

  test('títulos curtos (ideal + 1) e capitalizados', () => {
    for (const ex of EXTRACT_EXAMPLES) {
      for (const f of ex.facts) {
        const words = f.title.split(/\s+/).filter(Boolean);
        expect(words.length).toBeLessThanOrEqual(TITLE_IDEAL_WORDS + 1);
        expect(f.title[0]).toBe(f.title[0]?.toUpperCase());
      }
    }
  });

  test('todo fato é sobre a pessoa e nunca voz do assistente', () => {
    for (const ex of EXTRACT_EXAMPLES) {
      for (const f of ex.facts) {
        expect(f.text.toLowerCase()).toContain('o usuário');
        expect(ASSISTANT_VOICE.test(f.text)).toBe(false);
      }
    }
  });

  test('renderExamples usa o mesmo formato do turno real', () => {
    const rendered = renderExamples();
    expect(rendered).toContain('PESSOA:\n');
    expect(rendered).toContain('\n\nASSISTENTE:\n');
    expect(rendered).toContain('→ {"facts":');
    for (const ex of EXTRACT_EXAMPLES) {
      expect(rendered).toContain(ex.user);
    }
  });

  test('prompt embute os exemplos e remove dado real antigo', () => {
    const prompt = buildChatExtractPrompt({ user: 'probe', date: '2026-11-16' });
    for (const ex of EXTRACT_EXAMPLES) {
      expect(prompt).toContain(ex.user);
    }
    expect(prompt).toContain('OUTRO projeto');
    expect(prompt).not.toContain('Haiku 5.5');
    expect(prompt).not.toContain('chapado');
    expect(prompt).toContain('Estado do dia (dor, humor, sono de ontem)');
    expect(prompt).toContain('sem adjetivos novos');
  });
});

describe('normalizeChatTitle', () => {
  const FACT = 'O usuário toma sertralina 50mg de manhã.';
  test('tira âncora, aspas e ponto final', () => {
    expect(normalizeChatTitle('O usuário toma sertralina', FACT)).toBe('Toma sertralina');
    expect(normalizeChatTitle('"Dor pulsante na têmpora."', FACT)).toBe('Dor pulsante na têmpora');
  });
  test('trunca em 6 palavras sem partir palavra', () => {
    expect(normalizeChatTitle('uma duas três quatro cinco seis sete', FACT))
      .toBe('Uma duas três quatro cinco seis');
  });
  test('vazio ou não-string cai no fallback do fato', () => {
    expect(normalizeChatTitle('', FACT)).toBe('Toma sertralina 50mg de manhã');
    expect(normalizeChatTitle(undefined, FACT)).toBe('Toma sertralina 50mg de manhã');
    expect(normalizeChatTitle(42, FACT)).toBe('Toma sertralina 50mg de manhã');
  });
});

describe('fallbackTitleFromFact', () => {
  test('corpo com cópula: ancora + "está com" somem', () => {
    expect(fallbackTitleFromFact('O usuário está com dor pulsante na têmpora.'))
      .toBe('Dor pulsante na têmpora');
  });
  test('"tem Seinfeld" vira substantivo na frente', () => {
    expect(fallbackTitleFromFact(USER_COMFORT)).toBe('Seinfeld como série conforto já');
  });
  test('marcador de passado sai, fato fica', () => {
    expect(fallbackTitleFromFact(
      'Na época agitada antes do surto, o usuário vivia chapado, tinha dor pulsante na têmpora, fumava e trabalhava 24h.'
    )).toBe('Vivia chapado tinha dor pulsante');
  });
});

describe('backfill helpers', () => {
  test('isTitleCandidate: pula bundle, vazio e já titulados', () => {
    expect(isTitleCandidate({ memory: 'O usuário toma sertralina.', title: null })).toBe(true);
    expect(isTitleCandidate({ memory: '[Bundle: diario 2026-11-07] resumo', title: null })).toBe(false);
    expect(isTitleCandidate({ memory: '  ', title: null })).toBe(false);
    expect(isTitleCandidate({ memory: 'O usuário toma sertralina.', title: 'sertralina diária' })).toBe(false);
    expect(isTitleCandidate({})).toBe(false);
  });
  test('buildTitlePrompt carrega as mesmas regras do extrator', () => {
    const p = buildTitlePrompt('O usuário toma sertralina 50mg de manhã.');
    expect(p).toContain('ideal 3 palavras, máximo 6');
    expect(p).toContain('Sem "o usuário"');
    expect(p).toContain('{"title":"..."}');
    expect(p).toContain('O usuário toma sertralina 50mg de manhã.');
  });
});

describe('rememberChatTurn', () => {
  test('não salva o bloco do Seinfeld; salva só o fato do usuário, sem bundle, e repassa o título', async () => {
    const saved: Array<{ fact: string; project: string | undefined; title?: string }> = [];
    const states: Array<{ id: string; importance: number; kind: string; sensitive: boolean }> = [];
    const result = await rememberChatTurn(
      { user: 'seinfeld é comfy', assistant: ASSISTANT_FESTIVUS, project: 'diario', date: '2026-11-14' },
      {
        extract: async () => [{ text: USER_COMFORT, title: 'Seinfeld série conforto' }],
        save: async (fact, project, title) => {
          saved.push({ fact, project, title });
          return [{ id: 'atom-1', memory: fact, action: 'ADD' }];
        },
        writeState: async (id, s) => { states.push({ id, ...s }); },
      },
    );
    expect(saved).toEqual([{ fact: USER_COMFORT, project: 'diario', title: 'Seinfeld série conforto' }]);
    expect(result[0]).toMatchObject({ id: 'atom-1', title: 'Seinfeld série conforto' });
    // Sem rating no fato → padrões 3/fact/false → importância neutra 0.5.
    expect(states).toEqual([{ id: 'atom-1', importance: 0.5, kind: 'fact', sensitive: false, relevance: 3 }]);
  });

  test('extração vazia não chama o save', async () => {
    let saves = 0;
    const result = await rememberChatTurn(
      { user: 'oi', assistant: ASSISTANT_PARKING, project: 'diario' },
      {
        extract: async () => [],
        save: async () => {
          saves++;
          return [];
        },
      },
    );
    expect(saves).toBe(0);
    expect(result[0]).toMatchObject({ id: 'noop', action: 'NOOP' });
  });

  test('duplicata (NOOP) não carrega título no resultado', async () => {
    const result = await rememberChatTurn(
      { user: 'seinfeld é comfy', project: 'diario' },
      {
        extract: async () => [{ text: USER_COMFORT, title: 'Seinfeld série conforto' }],
        save: async (fact) => [{ id: 'duplicate', memory: fact, action: 'NOOP', superseded: [] }],
        writeState: async () => {},
      },
    );
    expect(result[0]).toMatchObject({ id: 'duplicate' });
    expect(result[0]?.title).toBeUndefined();
  });

  test('falha do extrator não salva a transcrição', async () => {
    let saves = 0;
    await expect(rememberChatTurn(
      { user: 'to revendo seinfeld', assistant: ASSISTANT_FESTIVUS, project: 'diario' },
      {
        extract: async () => { throw new Error('llm down'); },
        save: async () => {
          saves++;
          return [];
        },
      },
    )).rejects.toThrow('llm down');
    expect(saves).toBe(0);
  });
});

describe('sanitizeChatRating', () => {
  test('válido passa direto', () => {
    expect(sanitizeChatRating({ relevance: 5, kind: 'state', sensitive: true }))
      .toEqual({ relevance: 5, kind: 'state', sensitive: true });
  });

  test('ausente vira padrão 3/fact/false', () => {
    expect(sanitizeChatRating({})).toEqual({ relevance: 3, kind: 'fact', sensitive: false });
    expect(sanitizeChatRating(undefined)).toEqual({ relevance: 3, kind: 'fact', sensitive: false });
    expect(sanitizeChatRating('lixo')).toEqual({ relevance: 3, kind: 'fact', sensitive: false });
  });

  test('fora da faixa, não-inteiro e tipo errado caem no padrão sem descartar o fato', () => {
    for (const relevance of [0, 6, 2.5, '4', null, NaN]) {
      expect(sanitizeChatRating({ relevance }).relevance).toBe(3);
    }
    expect(sanitizeChatRating({ kind: 'mood' }).kind).toBe('fact');
    expect(sanitizeChatRating({ kind: 42 }).kind).toBe('fact');
    expect(sanitizeChatRating({ sensitive: 1 }).sensitive).toBe(false);
    expect(sanitizeChatRating({ sensitive: 'sim' }).sensitive).toBe(false);
  });

  test('normalizeChatFactPairs nunca descarta fato por rating ruim', () => {
    const facts = normalizeChatFactPairs([{ text: USER_COMFORT, relevance: 99, kind: 'x', sensitive: 'sim' }]);
    expect(facts).toEqual([{ text: USER_COMFORT, title: 'Seinfeld como série conforto já', relevance: 3, kind: 'fact', sensitive: false }]);
  });

  test('normalizeChatFactPairs preserva rating válido', () => {
    const facts = normalizeChatFactPairs([{ text: USER_COMFORT, title: 'conforto', relevance: 5, kind: 'state', sensitive: true }]);
    expect(facts).toEqual([{ text: USER_COMFORT, title: 'Conforto', relevance: 5, kind: 'state', sensitive: true }]);
  });
});

describe('relevanceToImportance', () => {
  test('mapeamento 1→0.2, 2→0.35, 3→0.5, 4→0.7, 5→0.85; resto → 0.5', () => {
    expect([1, 2, 3, 4, 5].map(relevanceToImportance)).toEqual([0.2, 0.35, 0.5, 0.7, 0.85]);
    expect(relevanceToImportance(0)).toBe(0.5);
    expect(relevanceToImportance(9)).toBe(0.5);
  });

  test('buildFactRatingPrompt reusa os critérios sem duplicar o texto', () => {
    const p = buildFactRatingPrompt('O usuário toma sertralina 50mg de manhã.');
    expect(p).toContain(CHAT_FACT_RATING_CRITERIA);
    expect(p).toContain('O usuário toma sertralina 50mg de manhã.');
    expect(p).toContain('{"relevance":3,"kind":"fact","sensitive":false}');
    expect(p).not.toContain('o usuário",');
  });

  test('rateChatFact valida e normaliza; resposta inútil vira erro', async () => {
    const ok = await rateChatFact('O usuário dorme tarde.', async () => ({ relevance: 2, kind: 'state' }));
    expect(ok).toEqual({ relevance: 2, kind: 'state', sensitive: false });
    await expect(rateChatFact('x', async () => ({}))).rejects.toThrow('unusable rating');
    await expect(rateChatFact('x', async () => null as unknown as undefined)).rejects.toThrow('unusable rating');
  });
});

describe('buildChatExtractPrompt rating', () => {
  test('prompt cobra relevance/kind/sensitive com os critérios exportados', () => {
    const p = buildChatExtractPrompt({ user: 'oi', date: '2026-11-14' });
    expect(p).toContain(CHAT_FACT_RATING_CRITERIA);
    expect(p).toContain('1 = detalhe passageiro');
    expect(p).toContain('"relevance":3,"kind":"fact","sensitive":false');
  });
});

describe('rememberChatTurn estado do extrator', () => {
  // Textos adversariais: os regex dariam valores DIFERENTES — se o caminho de
  // chat chamasse scoreImportance/heuristicKind, estes testes quebrariam.
  const DECISION = 'O usuário decidiu usar o Haiku 5.5 como modelo de conversa.'; // regex: ≥0.35 ("decidiu" + número)
  const PAIN = 'O usuário está com dor pulsante na têmpora.'; // heuristicKind: 'state' ("está com")

  test('writeState recebe importância/kind/sensitive do extrator, não dos regex', async () => {
    const seen: Array<{ id: string; s: { importance: number; kind: string; sensitive: boolean } }> = [];
    const ratings: unknown[] = [];
    await rememberChatTurn(
      { user: 'x', project: 'diario' },
      {
        extract: async () => [
          { text: DECISION, title: 'Haiku 5.5 como modelo', relevance: 1, kind: 'fact', sensitive: true },
          { text: PAIN, title: 'dor pulsante na têmpora', relevance: 5, kind: 'fact', sensitive: false },
        ],
        save: async (fact, project, title, rating) => {
          ratings.push(rating);
          return [{ id: `id-${ratings.length}`, memory: fact, action: 'ADD' }];
        },
        writeState: async (id, s) => { seen.push({ id, s }); },
      },
    );
    expect(ratings).toEqual([
      { relevance: 1, kind: 'fact', sensitive: true },
      { relevance: 5, kind: 'fact', sensitive: false },
    ]);
    expect(seen).toEqual([
      { id: 'id-1', s: { importance: 0.2, kind: 'fact', sensitive: true, relevance: 1 } },
      { id: 'id-2', s: { importance: 0.85, kind: 'fact', sensitive: false, relevance: 5 } },
    ]);
  });

  test('falha no writeState loga o id e não derruba o turno', async () => {
    const result = await rememberChatTurn(
      { user: 'x', project: 'diario' },
      {
        extract: async () => [{ text: PAIN, title: 'dor', relevance: 5, kind: 'state', sensitive: false }],
        save: async (fact) => [{ id: 'atom-9', memory: fact, action: 'ADD' }],
        writeState: async () => { throw new Error('qdrant down'); },
      },
    );
    expect(result[0]).toMatchObject({ id: 'atom-9' });
  });
});

describe('prompt reforça "o usuário" mesmo com nome próprio', () => {
  test('buildChatExtractPrompt exige SEMPRE "o usuário" (nome do assistente não contamina)', () => {
    const prompt = buildChatExtractPrompt({
      user: 'prefiro café forte',
      assistant: 'Entendi, Ana! Vou lembrar disso.',
      date: '2026-11-20',
    });
    expect(prompt).toContain('deve SEMPRE usar "o usuário"');
    expect(prompt).toContain('mesmo que o assistente a chame pelo nome próprio');
  });
});

describe('tenant anchor (multitenant)', () => {
  test('acceptChatFact aceita fato ancorado no nome do tenant', () => {
    expect(acceptChatFact('Ana prefere café forte.', 'Ana')).toBe(true);
    expect(acceptChatFact('Ana prefere café forte.', 'ana')).toBe(true);
    expect(acceptChatFact('Ana Maria prefere café forte.', 'Ana Maria')).toBe(true);
    expect(acceptChatFact('A Ana prefere café forte e pontual.', 'Ana')).toBe(true);
  });

  test('sem tenantName, nome próprio sozinho não ancora', () => {
    expect(acceptChatFact('Ana prefere café forte.')).toBe(false);
    expect(acceptChatFact('Ana prefere café forte.', null)).toBe(false);
  });

  test('voz do assistente perde mesmo com nome do tenant', () => {
    expect(acceptChatFact('Segundo o assistente, Ana prefere café forte.', 'Ana')).toBe(false);
  });

  test('texto sem âncora continua rejeitado mesmo com tenantName', () => {
    expect(acceptChatFact('Café forte é bom demais à tarde.', 'Ana')).toBe(false);
    expect(acceptChatFact('sim', 'Ana')).toBe(false);
  });

  test('normalizeChatFactPairs aceita âncora do tenant e mantém verbatim', () => {
    const pairs = normalizeChatFactPairs(
      [{ text: 'Ana prefere café forte.', title: 'Café forte' }],
      'Ana',
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].text).toBe('Ana prefere café forte.');
  });

  test('extractChatFacts com tenant resolve display name (mock LLM devolve nome próprio)', async () => {
    const facts = await extractChatFacts(
      { user: 'prefiro café forte', assistant: 'Anotado, Ana!', date: '2026-11-20', tenant: 'nope-tenant-inexistente' },
      async () => ({ facts: ['Ana prefere café forte e coado na hora.'] }),
    );
    // Sem registro de display name, o slug vira âncora (fallback) — aqui o
    // slug não casa com "Ana", então cai no legado: só "o usuário" entra.
    expect(facts).toEqual([]);
  });
});

describe('detectLanguageHint (PT-BR)', () => {
  test('PT-BR com palavras acentuadas → pt-BR', () => {
    expect(detectLanguageHint('não está tudo bem, você também vai')).toBe('pt-BR');
    expect(detectLanguageHint('quando você chega, então a gente conversa porque isso importa')).toBe('pt-BR');
  });

  test('inglês → undefined', () => {
    expect(detectLanguageHint('User prefers Bun over npm')).toBeUndefined();
    expect(detectLanguageHint('The quick brown fox jumps over the lazy dog')).toBeUndefined();
  });

  test('texto curto com só 1 marcador → undefined', () => {
    expect(detectLanguageHint('para')).toBeUndefined();
    expect(detectLanguageHint('hello para world')).toBeUndefined();
    expect(detectLanguageHint('')).toBeUndefined();
  });

  test('acentos no limite da palavra não quebram o matching', () => {
    // "não" e "está" precisam contar como 2 hits mesmo com \b quebrado em JS.
    expect(detectLanguageHint('não está')).toBe('pt-BR');
    // "nãoX" colado não é palavra — só 1 hit ("você") → undefined.
    expect(detectLanguageHint('nãoXyz você')).toBeUndefined();
  });
});
