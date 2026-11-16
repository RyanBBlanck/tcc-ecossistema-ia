# Lovable Worker — Workflow 2 do TCC

Worker local em Node.js que fica entre o **n8n (rodando em Docker)** e o
**Claude Code + Lovable MCP (rodando no Windows)**.

```
n8n (Docker) --HTTP--> worker (Windows, este projeto) --spawn--> claude -p --MCP--> Lovable
```

## Pré-requisitos

Antes de rodar este worker, confirme no PowerShell (fora do Docker):

```powershell
claude --version
claude mcp list          # deve mostrar "lovable" conectado
```

Se "lovable" não aparecer, rode primeiro:

```powershell
claude mcp add --transport http lovable https://mcp.lovable.dev
claude mcp login lovable
```

## Instalação

```powershell
cd worker
npm install
copy .env.example .env
```

Edite o `.env` e defina uma `WORKER_API_KEY` (qualquer string secreta) — ela
protege o endpoint de ser chamado por qualquer processo na sua rede local.

## Rodar

```powershell
npm start
```

Você deve ver:

```
Lovable worker rodando em http://localhost:3030
No n8n (Docker), chame: http://host.docker.internal:3030/lovable/develop
```

## Testar manualmente (antes de plugar no n8n)

```powershell
curl -X POST http://localhost:3030/lovable/develop `
  -H "Content-Type: application/json" `
  -H "x-api-key: troque-por-um-valor-secreto" `
  -d '{
    "issue_id": 2,
    "project_name": "NOME DO SEU PROJETO NO LOVABLE",
    "title": "Add CPF field to customer registration",
    "requirements": [
      "Add a CPF field to the customer registration form.",
      "The CPF field must be mandatory.",
      "The CPF must be displayed with the mask XXX.XXX.XXX-XX.",
      "Store CPF as digits only.",
      "Validate CPF using the Brazilian CPF check digit algorithm.",
      "Reject repeated digit sequences such as 00000000000 and 11111111111.",
      "Prevent duplicated CPF values.",
      "When a duplicated CPF is entered, show: A customer with this CPF is already registered."
    ]
  }'
```

Resposta esperada (formato):

```json
{
  "ok": true,
  "issue_id": 2,
  "success": true,
  "lovable_project_id": "...",
  "summary": "...",
  "changed_files": ["..."],
  "diff_summary": "...",
  "warnings": [],
  "next_recommended_status": "Waiting for Tests"
}
```

Isso pode levar de 30s a alguns minutos, dependendo da complexidade da
mudança no Lovable — é normal.

## Integrar no n8n (Workflow 2)

No n8n, depois do node que filtra `status = Under Development` e
`Artifacts Approved? = true`, adicione um node **HTTP Request**:

- **Method**: POST
- **URL**: `http://host.docker.internal:3030/lovable/develop`
- **Headers**: `x-api-key: troque-por-um-valor-secreto` (mesmo valor do `.env`)
- **Body (JSON)**:

```json
{
  "issue_id": "={{ $json.id }}",
  "project_name": "NOME DO PROJETO NO LOVABLE",
  "title": "={{ $json.subject }}",
  "requirements": "={{ $json.approved_requirements }}"
}
```

(ajuste os campos conforme como vocês estruturaram os artefatos aprovados
no Redmine — provavelmente vem de `custom_fields` ou das notas geradas
no Workflow 1).

Depois desse node, use a resposta (`success`, `summary`, `changed_files`,
`next_recommended_status`) para montar o PUT que atualiza a issue no
Redmine, exatamente como no Workflow 1.

## Por que este design

- **`spawn` com array de argumentos (sem shell)**: evita que texto vindo de
  uma issue do Redmine (título, requisitos) seja interpretado como comando
  de shell.
- **`--allowedTools "mcp__lovable__*"`**: obrigatório em modo `-p`
  (não-interativo). Sem essa flag, a primeira chamada ao Lovable MCP fica
  esperando uma aprovação de permissão que nunca chega, e o processo trava
  até estourar o timeout.
- **`x-api-key`**: o endpoint fica exposto na sua rede local via
  `host.docker.internal`; a chave evita que qualquer outro processo na
  máquina dispare alterações no seu projeto Lovable.
- **Timeout configurável**: mudanças mais complexas no Lovable podem levar
  vários minutos; ajuste `CLAUDE_TIMEOUT_MS` se necessário.

## Próximo passo

Depois de validar isso rodando manualmente e via n8n, o próximo passo do
TCC é o **Workflow 3 (Testes automatizados)**: usar Playwright para testar
o app publicado pelo Lovable (não a interface do Lovable em si), e
registrar o resultado no Redmine.
