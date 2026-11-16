# Worker — Claude Code + Lovable

Servidor Node.js (Express) que fica entre o **n8n** (rodando em Docker) e o
**Claude Code**, que roda no Windows conectado ao **Lovable** via MCP.

```
n8n (Docker) --HTTP--> worker (Windows) --spawn--> claude -p --MCP--> Lovable
```

Ele roda fora do Docker porque precisa da instalação local do Claude Code,
já autenticada.

## Endpoints

Todos os `POST` exigem o header `x-api-key` com o valor de `WORKER_API_KEY`,
quando ele está definido no `.env`.

| Endpoint | Usado por | Ferramentas do Lovable liberadas | O que faz |
| --- | --- | --- | --- |
| `POST /redmine/generate-artifacts` | Workflow 1 | Somente leitura | Analisa o chamado com base no código real do projeto e gera os artefatos de requisitos. |
| `POST /lovable/develop` | Workflow 2 | Leitura + `send_message` | Implementa os requisitos aprovados no projeto Lovable. |
| `POST /lovable/review` | Workflow 3 | Somente leitura | Revisa estaticamente se a implementação atende aos requisitos. |
| `GET /health` | — | — | Retorna `{"status":"ok"}`. |

### `POST /redmine/generate-artifacts`

```json
{
  "issue_id": 12,
  "title": "Adicionar CPF no cadastro de clientes",
  "description": "...",
  "previous_snapshot": null,
  "latest_comments_text": "",
  "project_name": "opcional; se omitido, usa LOVABLE_PROJECT_NAME"
}
```

- `previous_snapshot`: JSON da análise anterior, ou `null` na primeira rodada.
  O agente **atualiza** essa análise em vez de recomeçar do zero.
- `latest_comments_text`: só os comentários feitos depois da última rodada da
  automação, não o histórico inteiro do chamado.
- O prompt obriga o agente a ler os arquivos do projeto antes de responder. O
  worker confere, pela saída `stream-json` do Claude Code, se houve chamadas a
  `read_file`. Se nenhum arquivo foi lido, repete a análise **uma vez**; se
  ainda assim nada for lido, devolve um aviso.

Resposta: `summary`, `issue_classification`, `user_story`,
`acceptance_criteria`, `system_modules_affected`, `development_tasks`,
`test_cases`, `code_context`, `assumptions`, `open_questions` (em pt-BR),
`warnings` e `worker_diagnostics` (arquivos lidos, se houve nova tentativa e
ferramentas usadas).

### `POST /lovable/develop`

```json
{
  "issue_id": 12,
  "project_name": "NOME_DO_SEU_PROJETO_NO_LOVABLE",
  "title": "Adicionar CPF no cadastro de clientes",
  "requirements": "texto livre ou array de requisitos",
  "previous_review_feedback": "opcional: nota da última revisão reprovada",
  "rules": ["opcional: substitui as regras padrão"]
}
```

- Quando `previous_review_feedback` é enviado, o prompt deixa claro que se
  trata de um **retrabalho**. O agente deve corrigir o que a revisão apontou,
  sem refazer tudo do zero.
- Regras padrão:
  - não alterar funcionalidades não relacionadas;
  - manter layout e estilo;
  - não mexer em dependências sem pedido explícito;
  - fazer mudanças de banco pela ferramenta de migração do Lovable;
  - nunca reverter arquivos gerenciados pela plataforma (Drizzle, arquivos gerados, atualizações de versão).

Resposta: `success`, `lovable_project_id`, `summary`, `changed_files`,
`diff_summary`, `warnings` e `next_recommended_status`. Este último é sempre
`Waiting for Tests`, `Automation Error` ou `Waiting for Artifact Approval`.

### `POST /lovable/review`

Body: `issue_id`, `project_name`, `title`, `requirements`.

O Workflow 3 envia em `requirements` a descrição do chamado seguida de todos
os comentários humanos, em ordem cronológica. O agente primeiro consolida a
lista final de requisitos (o comentário mais recente vale quando há conflito)
e depois revisa o projeto contra essa lista.

Revisão **estática** do código e do diff (o app não é executado). Ela aponta
requisitos faltando ou incorretos e alterações fora do escopo. Mudanças feitas
pela própria plataforma não contam como problema.

Resposta: `approved`, `summary`, `concerns`, `feedback_for_developer` (vai
literalmente para a nota do Redmine e orienta o próximo ciclo de
desenvolvimento) e `recommended_status`. Este último é sempre
`Waiting for Tests Approval`, `Waiting for Development` (retrabalho) ou
`Automation Error`.
Se a resposta não for um JSON válido, o worker trata a revisão como
**reprovada**.

## Pré-requisitos

1. Node.js 18+.
2. Claude Code instalado e autenticado na mesma máquina.
3. O conector do **Lovable** habilitado na sua conta claude.ai. O worker usa
   as ferramentas com o prefixo `mcp__claude_ai_Lovable__`, que é o nome que o
   Claude Code dá ao conector "claude.ai Lovable". Para conferir:

   ```powershell
   claude --version
   claude mcp list   # deve mostrar "claude.ai Lovable" conectado
   ```

   Se você adicionar o MCP localmente (`claude mcp add ... lovable`), o
   prefixo das ferramentas passa a ser outro. Nesse caso, ajuste as listas
   `ALLOWED_LOVABLE_TOOLS_*` no `server.js`.

## Instalação e execução

```powershell
cd worker
npm install
copy .env.example .env
npm start
```

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3030` | Porta HTTP. |
| `WORKER_API_KEY` | — | Valor esperado no header `x-api-key`. Recomendado. |
| `CLAUDE_BIN` | `claude` | Caminho do executável do Claude Code. |
| `CLAUDE_TIMEOUT_MS` | `600000` | Tempo máximo de cada execução (10 min). |
| `LOVABLE_PROJECT_NAME` | — | Projeto padrão (usado na geração de artefatos quando o n8n não envia `project_name`). |
| `LOVABLE_PROJECT_ID` | — | ID do projeto no Lovable. Evita que o agente perca tempo procurando o projeto. |

Ao iniciar, o worker mostra os endpoints e as ferramentas liberadas em cada um.

## Testar manualmente

```powershell
curl -X POST http://localhost:3030/lovable/develop `
  -H "Content-Type: application/json" `
  -H "x-api-key: troque-por-um-valor-secreto" `
  -d '{
    "issue_id": 2,
    "project_name": "NOME_DO_SEU_PROJETO_NO_LOVABLE",
    "title": "Add CPF field to customer registration",
    "requirements": [
      "Add a CPF field to the customer registration form.",
      "The CPF field must be mandatory.",
      "Validate CPF using the Brazilian CPF check digit algorithm."
    ]
  }'
```

A execução pode levar de 30 segundos a alguns minutos, dependendo da mudança.

## Decisões de projeto

- **Ferramentas liberadas por endpoint (menor privilégio)**: cada endpoint
  recebe uma lista explícita via `--allowedTools`. Revisão e geração de
  artefatos **não** recebem `send_message`, então a própria permissão impede
  essas etapas de alterar o projeto, não só a instrução no prompt.
  Ferramentas administrativas (deploy, consultas ao banco, visibilidade etc.)
  ficam de fora em todos os endpoints.
- **Lista explícita em vez de curinga**: o curinga `mcp__...__*` em
  `--allowedTools` pode falhar silenciosamente na CLI.
- **`spawn` sem shell e prompt via stdin**: texto vindo do Redmine nunca é
  interpretado como comando. Enviar o prompt pelo stdin também evita o erro
  `ENAMETOOLONG`, causado pelo limite de tamanho da linha de comando do
  Windows.
- **Fila FIFO**: só um processo `claude` roda por vez, independentemente do
  endpoint, porque todos usam a mesma sessão e o mesmo projeto Lovable. Se uma
  execução falhar, a fila continua.
- **`--output-format stream-json`**: registra cada chamada de ferramenta, o
  que permite verificar se o código foi lido e detectar permissões negadas. As
  permissões negadas voltam em `missing_tool_permissions`.
- **Timeout configurável**: o processo é encerrado após `CLAUDE_TIMEOUT_MS`.
