import { describe, expect, test } from 'bun:test';
import {
  acceptChatFact,
  buildChatExtractPrompt,
  extractChatFacts,
  fallbackTitleFromFact,
  normalizeChatFacts,
  normalizeChatFactPairs,
  normalizeChatTitle,
  rememberChatTurn,
} from './chat-extract.js';

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
    expect(facts).toEqual([{ text: USER_MARKED, title: 'reassistindo Seinfeld em ordem disse' }]);
  });

  test('aceita o formato novo {text,title} e normaliza o título', async () => {
    const facts = await extractChatFacts(
      { user: 'to revendo seinfeld', date: '2026-11-14' },
      async () => ({ facts: [{ text: USER_MARKED, title: 'O usuário curtiu a vaga do George.' }] }),
    );
    expect(facts).toEqual([{ text: USER_MARKED, title: 'curtiu a vaga do George' }]);
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

  test('o prompt pede {text,title} com teto de 6 palavras', () => {
    const prompt = buildChatExtractPrompt({ user: 'tomo sertralina', date: '2026-11-14' });
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('máximo 6');
    expect(prompt).toContain('Sem "o usuário"');
    expect(prompt).toContain('{"facts":[{"text":"...","title":"..."}]}');
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
    expect(pairs[0]).toEqual({ text: USER_COMFORT, title: 'Seinfeld série conforto' });
    // título vazio cai no fallback do corpo
    expect(pairs[1]).toEqual({ text: USER_MARKED, title: 'reassistindo Seinfeld em ordem disse' });
    expect(pairs[3]).toEqual({ text: 'O usuário dorme tarde.', title: 'dorme tarde' });
  });
});

describe('normalizeChatTitle', () => {
  const FACT = 'O usuário toma sertralina 50mg de manhã.';
  test('tira âncora, aspas e ponto final', () => {
    expect(normalizeChatTitle('O usuário toma sertralina', FACT)).toBe('toma sertralina');
    expect(normalizeChatTitle('"Dor pulsante na têmpora."', FACT)).toBe('Dor pulsante na têmpora');
  });
  test('trunca em 6 palavras sem partir palavra', () => {
    expect(normalizeChatTitle('uma duas três quatro cinco seis sete', FACT))
      .toBe('uma duas três quatro cinco seis');
  });
  test('vazio ou não-string cai no fallback do fato', () => {
    expect(normalizeChatTitle('', FACT)).toBe('toma sertralina 50mg de manhã');
    expect(normalizeChatTitle(undefined, FACT)).toBe('toma sertralina 50mg de manhã');
    expect(normalizeChatTitle(42, FACT)).toBe('toma sertralina 50mg de manhã');
  });
});

describe('fallbackTitleFromFact', () => {
  test('corpo com cópula: ancora + "está com" somem', () => {
    expect(fallbackTitleFromFact('O usuário está com dor pulsante na têmpora.'))
      .toBe('dor pulsante na têmpora');
  });
  test('"tem Seinfeld" vira substantivo na frente', () => {
    expect(fallbackTitleFromFact(USER_COMFORT)).toBe('Seinfeld como série conforto já');
  });
  test('marcador de passado sai, fato fica', () => {
    expect(fallbackTitleFromFact(
      'Na época agitada antes do surto, o usuário vivia chapado, tinha dor pulsante na têmpora, fumava e trabalhava 24h.'
    )).toBe('vivia chapado tinha dor pulsante');
  });
});

describe('rememberChatTurn', () => {
  test('não salva o bloco do Seinfeld; salva só o fato do usuário, sem bundle, e repassa o título', async () => {
    const saved: Array<{ fact: string; project: string | undefined; title?: string }> = [];
    const result = await rememberChatTurn(
      { user: 'seinfeld é comfy', assistant: ASSISTANT_FESTIVUS, project: 'diario', date: '2026-11-14' },
      {
        extract: async () => [{ text: USER_COMFORT, title: 'Seinfeld série conforto' }],
        save: async (fact, project, title) => {
          saved.push({ fact, project, title });
          return [{ id: 'atom-1', memory: fact, action: 'ADD' }];
        },
      },
    );
    expect(saved).toEqual([{ fact: USER_COMFORT, project: 'diario', title: 'Seinfeld série conforto' }]);
    expect(result[0]).toMatchObject({ id: 'atom-1', title: 'Seinfeld série conforto' });
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
