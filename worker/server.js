/**
 * Worker local que recebe requisições HTTP do n8n (rodando em Docker) e
 * executa o Claude Code (`claude -p`) usando o Lovable MCP para implementar
 * uma issue aprovada do Redmine.
 *
 * Fluxo:
 *   n8n (Docker) --HTTP--> este worker (Windows) --spawn--> claude -p --MCP--> Lovable
 *
 * Rode este worker no Windows (fora do Docker), na mesma máquina onde você
 * já autenticou o Claude Code e conectou o servidor MCP "lovable"
 * (claude mcp add --transport http lovable https://mcp.lovable.dev).
 */

require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3030;
const API_KEY = process.env.WORKER_API_KEY || null; // opcional, ver README
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000); // 10 min

// Projeto Lovable padrão (opcionais, no .env). Usados quando o n8n não manda
// project_name, e o ID evita que o agente gaste tempo procurando o projeto.
const DEFAULT_LOVABLE_PROJECT_NAME = process.env.LOVABLE_PROJECT_NAME || null;
const LOVABLE_PROJECT_ID = process.env.LOVABLE_PROJECT_ID || null;

function projectRef(project_name) {
  return LOVABLE_PROJECT_ID
    ? `"${project_name}" (Lovable project id: ${LOVABLE_PROJECT_ID})`
    : `"${project_name}"`;
}

const DEFAULT_RULES = [
  'Do not modify unrelated features.',
  'Keep the existing layout and visual style.',
  'Do not add, remove or change application dependencies in package.json yourself, unless a dependency change is explicitly listed in the approved requirements.',
  'Database schema changes (tables, columns, functions, triggers, policies) must be made with the Lovable platform\'s own database migration tool, exactly as the platform does it.',
  'Changes made automatically by the Lovable platform are expected and must NEVER be reverted or deleted: the drizzle.config.ts file and the drizzle/ folder, ' +
    'the dependencies its migration tool adds (drizzle-kit, drizzle-orm, postgres), platform version bumps in package.json or bun.lock, and generated files ' +
    '(src/routeTree.gen.ts, src/integrations/supabase/types.ts, src/integrations/supabase/previewAuthStorage.ts).',
];

/**
 * Arquivos e alterações gerenciados pela própria plataforma Lovable. O revisor
 * não deve tratá-los como "alteração fora do escopo": na issue #15, pedir a
 * remoção do Drizzle quebrou a ferramenta de migração do Lovable.
 */
const PLATFORM_MANAGED_NOTE =
  'Platform-managed changes are NOT unrelated changes and must not be flagged or reverted: the drizzle.config.ts file and the ' +
  'drizzle/ folder (this is how the Lovable platform runs database migrations), the drizzle-kit / drizzle-orm / postgres ' +
  'dependencies added by that migration tool, version bumps of Lovable or framework packages in package.json / bun.lock, and ' +
  'generated files (src/routeTree.gen.ts, src/integrations/supabase/types.ts, src/integrations/supabase/previewAuthStorage.ts). ' +
  'Never ask the developer to delete, revert or edit these, and never ask for anything the developer cannot do through the platform ' +
  '(for example, editing read-only or generated files).';

/**
 * Nome real do servidor MCP conforme "claude mcp list": "claude.ai Lovable"
 * (conectado via conta claude.ai, não via "claude mcp add" local).
 * O nome interno das tools normaliza espaços/pontos para "_":
 *   "claude.ai Lovable" -> mcp__claude_ai_Lovable__<tool>
 *
 * Lista explícita (em vez de wildcard "mcp__claude_ai_Lovable__*") porque
 * o wildcard para tools MCP via --allowedTools é conhecido por falhar
 * silenciosamente na CLI do Claude Code (issue #13077 no repo oficial).
 *
 * Restrita ao mínimo necessário para o Workflow 2 (princípio do menor
 * privilégio): o worker só precisa localizar o projeto, mandar a
 * instrução de implementação e conferir o resultado/diff. Tools
 * administrativas (deploy_project, query_database, delete_workspace_skill,
 * set_project_visibility, move_projects_to_folder, etc.) ficam de fora
 * de propósito.
 */
const ALLOWED_LOVABLE_TOOLS_DEVELOP = [
  'mcp__claude_ai_Lovable__list_projects',
  'mcp__claude_ai_Lovable__get_project',
  'mcp__claude_ai_Lovable__list_workspaces',
  'mcp__claude_ai_Lovable__send_message',
  'mcp__claude_ai_Lovable__get_message',
  'mcp__claude_ai_Lovable__list_messages',
  'mcp__claude_ai_Lovable__get_diff',
  'mcp__claude_ai_Lovable__list_files',
  'mcp__claude_ai_Lovable__read_file',
  'mcp__claude_ai_Lovable__get_database_status',
  'mcp__claude_ai_Lovable__get_me',
].join(',');

/**
 * Lista para o endpoint de REVISÃO — deliberadamente SEM "send_message"
 * (nem qualquer outra tool que altere o projeto). Isso garante, a nível de
 * permissão (não só de instrução no prompt), que a revisão nunca consegue
 * modificar o Lovable, mesmo que o modelo "decida" tentar.
 */
const ALLOWED_LOVABLE_TOOLS_REVIEW = [
  'mcp__claude_ai_Lovable__list_projects',
  'mcp__claude_ai_Lovable__get_project',
  'mcp__claude_ai_Lovable__list_workspaces',
  'mcp__claude_ai_Lovable__get_message',
  'mcp__claude_ai_Lovable__list_messages',
  'mcp__claude_ai_Lovable__get_diff',
  'mcp__claude_ai_Lovable__list_files',
  'mcp__claude_ai_Lovable__read_file',
  'mcp__claude_ai_Lovable__get_database_status',
  'mcp__claude_ai_Lovable__list_edits',
  'mcp__claude_ai_Lovable__get_me',
].join(',');

/**
 * Monta o prompt de implementação seguindo o padrão definido na Seção 10
 * do checkpoint do TCC.
 */
/**
 * Os requisitos aprovados podem chegar de duas formas do n8n:
 *  - string: texto livre (ex: a última nota do Redmine, como o time decidiu usar)
 *  - array: lista já estruturada de requisitos
 * Isso evita que o n8n precise fazer parsing frágil de texto livre em bullets.
 */
function formatRequirements(requirements) {
  if (!requirements || (Array.isArray(requirements) && requirements.length === 0)) {
    return '(nenhum requisito aprovado foi enviado — verifique o payload do n8n)';
  }
  if (Array.isArray(requirements)) {
    return requirements.map((r) => `- ${r}`).join('\n');
  }
  return String(requirements).trim();
}

function buildDevelopmentPrompt({ issue_id, project_name, title, requirements, rules, previous_review_feedback }) {
  const reqLines = formatRequirements(requirements);

  const ruleLines = (rules && rules.length ? rules : DEFAULT_RULES)
    .map((r) => `- ${r}`)
    .join('\n');

  const parts = [
    `Use Lovable MCP to update the existing Lovable project named ${projectRef(project_name)}.`,
    '',
    'Implement the approved Redmine issue below.',
    '',
    `Issue ID: ${issue_id}`,
    `Title: ${title || '(no title provided)'}`,
    '',
    'Approved requirements:',
    reqLines,
  ];

  if (previous_review_feedback && String(previous_review_feedback).trim()) {
    parts.push(
      '',
      'IMPORTANT — this is a REWORK cycle, not a first attempt. An automated review already ' +
        'inspected a previous implementation of this same issue and found it incomplete or ' +
        'incorrect. The review is reproduced verbatim below. You MUST specifically address the ' +
        'gaps it describes — do not just re-implement the requirements from scratch as if this ' +
        'were the first attempt, and do not undo parts that the review did not flag as a problem:',
      '',
      String(previous_review_feedback).trim()
    );
  }

  parts.push(
    '',
    'Rules:',
    ruleLines,
    '- After implementation, get the diff of the changes.',
    '- Return ONLY a raw JSON object (no markdown code fences, no extra commentary) with these fields:',
    '  - success (boolean)',
    '  - lovable_project_id (string)',
    '  - summary (string)',
    '  - changed_files (array of strings)',
    '  - diff_summary (string)',
    '  - warnings (array of strings)',
    '  - next_recommended_status (string) — MUST be exactly one of these literal values, no other text:',
    '      "Waiting for Tests"       (implementation succeeded, ready for QA)',
    '      "Automation Error"        (implementation failed or could not be completed)',
    '      "Waiting for Artifact Approval"  (requirements were unclear/insufficient to implement safely)'
  );

  return parts.join('\n');
}

/**
 * Monta o prompt de REVISÃO: pede pro Claude conferir (sem alterar nada)
 * se os requisitos aprovados foram implementados corretamente, e — se não
 * foram — devolver um comentário pontual e acionável do que precisa ser
 * ajustado (vai direto pra nota do Redmine, pro próximo ciclo de dev).
 */
function buildReviewPrompt({ issue_id, project_name, title, requirements }) {
  const reqLines = formatRequirements(requirements);

  return [
    `Use the Lovable connector to review the existing project named ${projectRef(project_name)}.`,
    '',
    'This is a REVIEW task, not an implementation task. Do NOT attempt to modify the ' +
      'project in any way — you do not have permission to send messages or make changes here, ' +
      'only to inspect it.',
    '',
    `Issue ID: ${issue_id}`,
    `Title: ${title || '(no title provided)'}`,
    '',
    'Approved requirements that should have been implemented:',
    reqLines,
    '',
    'Instructions:',
    '- Inspect the relevant project files (list_files / read_file) and the latest diff ' +
      '(get_diff) to check whether the approved requirements above were actually implemented, ' +
      'completely and correctly.',
    '- Flag any change that is unrelated to the approved requirements (e.g. dependencies added by ' +
      'hand, unrelated application files touched, unrelated behavior changes).',
    '- ' + PLATFORM_MANAGED_NOTE,
    '- Database changes made through drizzle/migrations are the platform\'s standard mechanism. A migration ' +
      'file there, together with the code, is enough evidence; do not reject only because you cannot query the database.',
    '- Only reject (approved=false) for problems that affect the approved requirements or introduce real ' +
      'unrelated application changes. Minor style remarks go in concerns but do not block approval.',
    '- Flag anything that looks incomplete, inconsistent, or likely to fail in practice, even ' +
      'though you cannot execute the app (this is a static review of code/diff, not a ' +
      'functional test — be explicit about that limitation in your summary).',
    '',
    'Return ONLY a raw JSON object (no markdown code fences, no extra commentary) with these fields:',
    '  - approved (boolean) — true only if the requirements appear correctly and completely',
    '      implemented, with no unrelated/unrequested changes',
    '  - summary (string) — short overall assessment',
    '  - concerns (array of strings) — specific issues found; empty array if none',
    '  - feedback_for_developer (string) — REQUIRED and must be specific and actionable when',
    '      approved=false: exactly what is missing/wrong and what should be changed. This text',
    '      will be posted verbatim as a note on the issue for the next development attempt.',
    '      Use an empty string when approved=true.',
    '  - recommended_status (string) — MUST be exactly one of these literal values, no other text:',
    '      "Waiting for Tests Approval"   (review passed, ready for human approval)',
    '      "Under Development"            (review failed, needs rework)',
    '      "Automation Error"             (review could not be completed)',
  ].join('\n');
}

/**
 * Geração de artefatos tem acesso de LEITURA ao projeto Lovable (mesma
 * lista restrita usada na revisão -- sem send_message, ou seja, sem
 * permissão de alterar nada). A leitura do código é OBRIGATÓRIA: o prompt
 * exige e o endpoint confere, pelas chamadas de read_file registradas na
 * saída stream-json, se o agente de fato leu os arquivos do projeto.
 */
const ALLOWED_TOOLS_ARTIFACTS = ALLOWED_LOVABLE_TOOLS_REVIEW;

/**
 * Monta o prompt de geração/atualização de artefatos.
 *
 * Em vez de reenviar o histórico inteiro da issue a cada rodada (o que
 * cresce sem limite e já causou ENAMETOOLONG numa issue com várias
 * idas-e-voltas), o worker recebe:
 *   - previous_snapshot: o JSON da última análise feita (ou null na 1ª vez)
 *   - latest_comments_text: só os comentários adicionados DEPOIS da última
 *     rodada da automação (não o histórico completo)
 * E devolve um snapshot ATUALIZADO e COMPLETO (não um diff), que
 * sobrescreve o campo customizado "Latest Artifacts Snapshot" no Redmine.
 */
function buildArtifactsPrompt({ issue_id, project_name, title, description, previous_snapshot, latest_comments_text }) {
  const hasPrevious = previous_snapshot && String(previous_snapshot).trim();
  const hasComments = latest_comments_text && String(latest_comments_text).trim();

  const parts = [
    'You are a business/requirements analyst helping a software team triage a support ticket ' +
      'before development starts.',
    '',
    `Issue ID: ${issue_id}`,
    `Title: ${title || '(no title provided)'}`,
    `Description: ${description || '(no description provided)'}`,
  ];

  if (project_name) {
    parts.push(
      '',
      'MANDATORY FIRST STEP — INSPECT THE PROJECT CODE BEFORE ANSWERING',
      `This ticket refers to the existing Lovable project named ${projectRef(project_name)}. ` +
        'You have READ-ONLY access to it via the Lovable connector (there is no send_message or any ' +
        'other tool that changes the project; attempting to use one will fail).',
      'Before writing ANY part of your answer you MUST inspect the current code of this project:',
      '  1. Locate the project (get_project with the id above; if no id is given, find it by name with ' +
        'list_projects) and get its latest commit.',
      '  2. Use list_files to understand the project structure (pages, components, hooks, types, ' +
        'Supabase migrations / database schema, edge functions).',
      '  3. Use read_file on every file that implements the screens, components, data model and ' +
        'business rules this ticket touches. If the ticket involves data, read the related database ' +
        'schema / migrations / type definitions as well.',
      '  4. Only then write your analysis.',
      'Your analysis must be grounded in what you actually found: refer to real screens, components, ' +
        'tables and fields; state whether what is being requested already exists (fully or partially); ' +
        'and base system_modules_affected and development_tasks on the actual files. An analysis written ' +
        'without reading the relevant files is considered a failed analysis.'
    );
  }

  if (hasPrevious) {
    parts.push(
      '',
      'You have already analyzed this ticket in a previous round. Your previous analysis ' +
        '(as structured JSON) is below. Do NOT start from scratch — treat this as your current ' +
        'understanding and UPDATE it based on the new information provided further below (e.g. ' +
        'answers to the open_questions you previously raised). Keep anything still valid, and only ' +
        'change what the new information actually affects.',
      '',
      'Your previous analysis (JSON):',
      String(previous_snapshot).trim(),
      '',
      'New comments since your previous analysis:',
      hasComments ? String(latest_comments_text).trim() : '(none)'
    );
  } else {
    parts.push(
      '',
      'This is the first analysis of this ticket.',
      '',
      'Comments so far, if any:',
      hasComments ? String(latest_comments_text).trim() : '(no comments yet)'
    );
  }

  parts.push(
    '',
    'Return ONLY a raw JSON object (no markdown code fences, no extra commentary) with these ' +
      'fields. This must be the FULL, complete, up-to-date analysis — not just what changed:',
    '  - summary (string) — 2-3 sentence summary of what is being requested',
    '  - issue_classification (string) — your classification of the type of work (e.g. "New Feature", "Bug Fix", "Enhancement", "Data Migration")',
    '  - user_story (string) — in "As a ..., I want ..., so that ..." format',
    '  - acceptance_criteria (array of strings)',
    '  - system_modules_affected (array of strings) — best guess at affected areas/modules of the system',
    '  - development_tasks (array of strings) — concrete implementation tasks a developer/AI agent would need to do',
    '  - test_cases (array of strings) — test cases that should be verified before this is considered done',
    '  - code_context (array of strings) — the project files you read and the key facts you learned',
    '      from each one (e.g. "src/pages/Clients.tsx: registration form has name, email and phone; no CPF field").',
    '      Empty array ONLY if no project was provided above.',
    '  - assumptions (array of strings) — reasonable decisions you made yourself instead of asking',
    '      (e.g. following an existing pattern in the code). Empty array if none.',
    '  - open_questions (array of strings) — business questions a human must answer before development',
    '      starts; EMPTY array if this is ready for development.',
    '      IMPORTANT: write every string in this array in Brazilian Portuguese (pt-BR), not English —',
    '      these questions are shown directly to a Portuguese-speaking administrator. All other fields',
    '      above (summary, user_story, acceptance_criteria, code_context, assumptions, etc.) must stay in English.',
    '',
    'Rules for open_questions:',
    '  - NEVER ask anything that can be answered by reading the project code or the ticket itself (which',
    '    fields a screen has, whether a feature already exists, what a table stores, how a screen currently',
    '    behaves, which technology is used). Look it up in the code instead.',
    '  - Do NOT ask technical or implementation questions (libraries, component structure, database design,',
    '    naming). Decide them yourself, following the patterns already used in the project.',
    '  - Only ask about business decisions that the code cannot answer and that would materially change what',
    '    gets built (business rules, permissions, who can see or do what, expected behavior in edge cases).',
    '  - If a reasonable default exists, do not ask: adopt it and record it in "assumptions".',
    '  - Write each question so a non-technical administrator can answer it, referring to screens and features',
    '    the way the user sees them. Prefer few, essential questions.',
    '  - Never repeat a question that has already been answered in the comments.',
  );

  return parts.join('\n');
}

/**
 * Executa `claude -p` como subprocesso (sem shell, args em array) e retorna
 * o stdout bruto. Usar spawn com array de args evita injeção de shell mesmo
 * que o prompt contenha texto vindo de um chamado do Redmine.
 */
function runClaude(prompt, allowedTools) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      // stream-json (exige --verbose) registra cada chamada de tool, o que
      // permite ao worker conferir se o agente realmente leu o código.
      '--output-format', 'stream-json',
      '--verbose',
      // Autoriza SOMENTE a lista explicita de tools passada pelo chamador
      // (diferente para /develop e /review — ver ALLOWED_LOVABLE_TOOLS_*).
      '--allowedTools', allowedTools,
    ];

    const child = spawn(CLAUDE_BIN, args, { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p excedeu o timeout de ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao iniciar o processo claude: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `claude saiu com código ${code}. stdout: ${tail(stdout) || '(vazio)'} | stderr: ${tail(stderr) || '(vazio)'}`
        ));
        return;
      }
      resolve(stdout);
    });

    // O prompt é escrito via stdin, NÃO como argumento de linha de comando.
    // Prompts grandes (issues com várias rodadas de perguntas/respostas
    // acumuladas nas notas) podem facilmente passar do limite de tamanho
    // de linha de comando do Windows, causando "spawn ENAMETOOLONG". Via
    // stdin esse limite praticamente não existe (o Claude Code aceita até
    // 10MB por essa via).
    child.stdin.on('error', () => {
      // Evita crash caso o processo filho já tenha fechado stdin
      // (ex: saída antecipada por erro); o 'close' acima já trata isso.
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Fila simples: garante que só existe UM processo `claude` rodando por vez,
 * não importa de qual endpoint (/develop, /review, /generate-artifacts) ou
 * de qual issue veio a chamada. Isso evita que duas issues diferentes
 * acabem sendo processadas ao mesmo tempo e mexendo no mesmo projeto
 * Lovable simultaneamente (o que poderia gerar conflito de edição, já que
 * todas usam a mesma sessão do Claude Code / conexão MCP).
 *
 * É uma fila FIFO baseada numa cadeia de Promises: cada chamada só começa
 * depois que a anterior terminou (com sucesso OU erro).
 */
let workerQueue = Promise.resolve();
let queueLength = 0;

function runClaudeQueued(prompt, allowedTools, label) {
  queueLength += 1;
  const positionWhenEnqueued = queueLength;
  if (positionWhenEnqueued > 1) {
    console.log(`[fila] "${label}" entrou na fila (posição ${positionWhenEnqueued}, aguardando ${positionWhenEnqueued - 1} chamada(s) à frente).`);
  }

  const run = workerQueue.then(async () => {
    console.log(`[fila] "${label}" começou a rodar agora.`);
    try {
      return await runClaude(prompt, allowedTools);
    } finally {
      queueLength -= 1;
      console.log(`[fila] "${label}" terminou.`);
    }
  });

  // A fila sempre segue adiante, mesmo se essa chamada falhar — senão uma
  // falha travaria permanentemente todas as chamadas seguintes.
  workerQueue = run.catch(() => {});

  return run;
}


/** Últimos caracteres de um texto longo (para mensagens de erro legíveis). */
function tail(text, max = 2000) {
  const s = String(text || '');
  return s.length > max ? '...' + s.slice(-max) : s;
}

/**
 * Lê a saída stream-json do Claude CLI (um JSON por linha) e devolve:
 *   - resultText: texto final do agente (o JSON pedido no prompt)
 *   - permissionDenials: tools que o agente tentou usar sem permissão
 *   - toolUses: todas as tools chamadas, com os parâmetros
 */
function parseClaudeCliOutput(cliOutput) {
  const toolUses = [];
  let resultEvent = null;

  for (const line of String(cliOutput).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch (e) { continue; }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_use') {
          toolUses.push({ name: block.name, input: block.input || {} });
        }
      }
    } else if (ev.type === 'result') {
      resultEvent = ev;
    }
  }

  if (!resultEvent) {
    throw new Error(`A saída do Claude CLI não tem o evento "result". Final da saída: ${tail(cliOutput)}`);
  }
  if (typeof resultEvent.result !== 'string') {
    throw new Error(`O Claude CLI terminou sem resposta final (subtype: ${resultEvent.subtype || 'desconhecido'}).`);
  }

  const permissionDenials = Array.isArray(resultEvent.permission_denials)
    ? resultEvent.permission_denials.map((d) => d.tool_name || JSON.stringify(d))
    : [];

  return { resultText: resultEvent.result, permissionDenials, toolUses };
}

/** Arquivos do projeto Lovable lidos pelo agente (chamadas a read_file). */
function filesRead(toolUses) {
  return toolUses
    .filter((t) => /__read_file$/.test(t.name || ''))
    .map((t) => t.input.path || t.input.file_path || t.input.filePath || JSON.stringify(t.input));
}

/** O texto do `result` deve ser o JSON que pedimos no prompt (summary, changed_files, etc). */
function parseLovableResult(resultText) {
  let cleaned = resultText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1];

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return {
      success: false,
      summary: 'O Claude respondeu, mas o texto não era um JSON válido. Veja raw_result.',
      raw_result: resultText,
      warnings: [`Erro ao fazer parse: ${e.message}`],
    };
  }
}

app.post('/lovable/develop', async (req, res) => {
  if (API_KEY && req.header('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'x-api-key inválida ou ausente' });
  }

  const { issue_id, project_name, title, requirements, rules, previous_review_feedback } = req.body || {};

  if (!project_name || !issue_id) {
    return res.status(400).json({ error: 'issue_id e project_name são obrigatórios no body.' });
  }

  const prompt = buildDevelopmentPrompt({ issue_id, project_name, title, requirements, rules, previous_review_feedback });

  try {
    const cliOutput = await runClaudeQueued(prompt, ALLOWED_LOVABLE_TOOLS_DEVELOP, `develop issue ${issue_id}`);
    const { resultText, permissionDenials } = parseClaudeCliOutput(cliOutput);
    const lovableResult = parseLovableResult(resultText);

    if (permissionDenials.length) {
      lovableResult.warnings = [...(lovableResult.warnings || [])];
      lovableResult.warnings.push(
        `Permissões negadas pelo Claude CLI (adicione em ALLOWED_LOVABLE_TOOLS_DEVELOP): ${permissionDenials.join(', ')}`
      );
      lovableResult.missing_tool_permissions = permissionDenials;
    }

    return res.json({ ok: true, issue_id, ...lovableResult });
  } catch (err) {
    return res.status(500).json({ ok: false, issue_id, error: err.message });
  }
});

app.post('/lovable/review', async (req, res) => {
  if (API_KEY && req.header('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'x-api-key inválida ou ausente' });
  }

  const { issue_id, project_name, title, requirements } = req.body || {};

  if (!project_name || !issue_id) {
    return res.status(400).json({ error: 'issue_id e project_name são obrigatórios no body.' });
  }

  const prompt = buildReviewPrompt({ issue_id, project_name, title, requirements });

  try {
    const cliOutput = await runClaudeQueued(prompt, ALLOWED_LOVABLE_TOOLS_REVIEW, `review issue ${issue_id}`);
    const { resultText, permissionDenials } = parseClaudeCliOutput(cliOutput);
    const reviewResult = parseLovableResult(resultText);

    // Se o parse do JSON falhou, o fallback do parseLovableResult devolve
    // "success: false" (formato genérico) em vez de "approved". Normaliza
    // aqui pra não quebrar o Code node do n8n, e trata como reprovado por
    // segurança (não aprova automaticamente algo que nem conseguimos ler).
    if (typeof reviewResult.approved === 'undefined') {
      reviewResult.approved = false;
    }

    if (permissionDenials.length) {
      reviewResult.warnings = [...(reviewResult.warnings || [])];
      reviewResult.warnings.push(
        `Permissões negadas pelo Claude CLI (adicione em ALLOWED_LOVABLE_TOOLS_REVIEW): ${permissionDenials.join(', ')}`
      );
      reviewResult.missing_tool_permissions = permissionDenials;
    }

    return res.json({ ok: true, issue_id, ...reviewResult });
  } catch (err) {
    return res.status(500).json({ ok: false, issue_id, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/redmine/generate-artifacts', async (req, res) => {
  if (API_KEY && req.header('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'x-api-key inválida ou ausente' });
  }

  const { issue_id, title, description, previous_snapshot, latest_comments_text } = req.body || {};
  const project_name = (req.body && req.body.project_name) || DEFAULT_LOVABLE_PROJECT_NAME;

  if (!issue_id) {
    return res.status(400).json({ error: 'issue_id é obrigatório no body.' });
  }

  const prompt = buildArtifactsPrompt({ issue_id, project_name, title, description, previous_snapshot, latest_comments_text });

  try {
    let cliOutput = await runClaudeQueued(prompt, ALLOWED_TOOLS_ARTIFACTS, `artifacts issue ${issue_id}`);
    let parsed = parseClaudeCliOutput(cliOutput);
    let files = filesRead(parsed.toolUses);
    let retried = false;

    // O agente respondeu sem ler nenhum arquivo do projeto: tenta UMA vez
    // mais, deixando explícito que a primeira resposta foi descartada.
    if (project_name && files.length === 0) {
      console.log(`[artifacts ${issue_id}] Nenhum arquivo do projeto foi lido. Repetindo a análise uma vez.`);
      retried = true;
      const retryPrompt = [
        'IMPORTANT: a previous attempt at this exact task was REJECTED because it answered without ' +
          'reading any file of the project (no read_file calls). This time you MUST follow the mandatory ' +
          'first step below and read the relevant files with read_file before writing your answer.',
        '',
        prompt,
      ].join('\n');
      cliOutput = await runClaudeQueued(retryPrompt, ALLOWED_TOOLS_ARTIFACTS, `artifacts issue ${issue_id} (nova tentativa)`);
      parsed = parseClaudeCliOutput(cliOutput);
      files = filesRead(parsed.toolUses);
    }

    const artifacts = parseLovableResult(parsed.resultText);
    artifacts.warnings = [...(artifacts.warnings || [])];

    if (!project_name) {
      artifacts.warnings.push(
        'Nenhum project_name recebido (nem LOVABLE_PROJECT_NAME no .env): a análise foi feita sem consultar o código do projeto.'
      );
    } else if (files.length === 0) {
      artifacts.warnings.push(
        'O agente não leu nenhum arquivo do projeto Lovable, mesmo após uma nova tentativa. Revise as perguntas com cuidado.'
      );
    }

    if (parsed.permissionDenials.length) {
      artifacts.warnings.push(`Permissões negadas pelo Claude CLI: ${parsed.permissionDenials.join(', ')}`);
      artifacts.missing_tool_permissions = parsed.permissionDenials;
    }

    console.log(`[artifacts ${issue_id}] Arquivos lidos (${files.length}): ${files.join(', ') || '(nenhum)'}`);

    return res.json({
      ok: true,
      issue_id,
      ...artifacts,
      worker_diagnostics: {
        project_name: project_name || null,
        code_consulted: files.length > 0,
        files_read: files,
        retried_for_missing_code_read: retried,
        tools_used: parsed.toolUses.map((t) => t.name),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, issue_id, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lovable worker rodando em http://localhost:${PORT}`);
  console.log(`No n8n (Docker), chame:`);
  console.log(`  POST http://host.docker.internal:${PORT}/lovable/develop`);
  console.log(`  POST http://host.docker.internal:${PORT}/lovable/review`);
  console.log(`  POST http://host.docker.internal:${PORT}/redmine/generate-artifacts`);
  console.log(`Tools liberadas em /develop (ALLOWED_LOVABLE_TOOLS_DEVELOP):`);
  console.log(`  ${ALLOWED_LOVABLE_TOOLS_DEVELOP.split(',').join('\n  ')}`);
  console.log(`Tools liberadas em /review (ALLOWED_LOVABLE_TOOLS_REVIEW, sem send_message):`);
  console.log(`  ${ALLOWED_LOVABLE_TOOLS_REVIEW.split(',').join('\n  ')}`);
  console.log(`Tools liberadas em /redmine/generate-artifacts (ALLOWED_TOOLS_ARTIFACTS, sem send_message):`);
  console.log(`  ${ALLOWED_TOOLS_ARTIFACTS.split(',').join('\n  ')}`);
});
