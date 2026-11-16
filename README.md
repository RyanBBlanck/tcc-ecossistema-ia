# Ecossistema de automação com IA — TCC

Código do ecossistema desenvolvido no meu Trabalho de Conclusão de Curso.
Ele automatiza o ciclo de vida de um chamado do **Redmine**: análise de
requisitos, desenvolvimento e revisão. O **n8n** orquestra o fluxo e o
**Claude Code**, conectado ao **Lovable** via MCP, atua como agente de IA.
Os pontos de decisão continuam com pessoas: aprovar os artefatos,
responder perguntas e aprovar o resultado final.

## Arquitetura

```
Redmine  <──REST──>  n8n (Docker)  ──HTTP──>  worker (Node.js, Windows)  ──spawn──>  claude -p  ──MCP──>  Lovable
```

- **Redmine**: onde ficam os chamados. O status de cada chamado define em que etapa ele está.
- **n8n**: quatro workflows que consultam o Redmine a cada 5 minutos, chamam o worker e gravam o resultado de volta no chamado (nota, status e campos customizados).
- **Worker** (`worker/`): servidor Express que recebe as chamadas do n8n, monta o prompt e executa o Claude Code em modo não interativo (`claude -p`). Ele libera só as ferramentas do Lovable necessárias em cada etapa.
- **Lovable**: plataforma onde fica o código da aplicação. O Claude Code lê o código do projeto e, na etapa de desenvolvimento, envia as instruções de implementação.

## Fluxo de um chamado

```
New ──WF1──> Under Analysis ──┬──> Waiting for Answers ──(admin responde)──> Questions Answered ──WF1──┐
                              │                                                                        │
                              └──> Waiting for Artifact Approval <──────────────────────────────────────┘
                                          │
                                  (humano aprova)
                                          ▼
                              Waiting for Development ──WF2──> Under Development ──> Waiting for Tests
                                                                                          │
                                                                                         WF3
                                                                                          ▼
                                                    Under Testing ──┬──> Waiting for Tests Approval  (aprovado)
                                                                    └──> Under Development + feedback (reprovado)

Qualquer falha do worker ──> Automation Error
```

### Workflow 1 — Geração de artefatos (`/redmine/generate-artifacts`)

1. Busca chamados abertos com o campo **AI Processing Required** marcado e status **New** ou **Questions Answered**.
2. Marca o chamado como **Under Analysis** e envia ao worker:
   - título e descrição;
   - o snapshot da análise anterior, se houver (campo **Latest Artifacts Snapshot**);
   - **apenas os comentários feitos depois da última nota da automação**. Assim o prompt não cresce a cada rodada.
3. O Claude Code atua como analista de requisitos. Ele tem **acesso somente leitura** ao projeto no Lovable e é obrigado a ler o código antes de responder. O worker confere pelos logs se algum arquivo foi de fato lido; se nenhum foi, repete a análise uma vez.
4. A resposta traz resumo, classificação, user story, critérios de aceite, módulos afetados, tarefas de desenvolvimento, casos de teste, premissas e perguntas em aberto (estas em português).
5. O n8n grava a análise como nota, atualiza o snapshot, zera o contador de tentativas de desenvolvimento e define o próximo status:
   - **Waiting for Answers**, se houver perguntas de negócio para o administrador. As perguntas também vão para um campo próprio, para serem exibidas no app. Quando o administrador confirma que respondeu, o app muda o status para **Questions Answered** e o workflow reprocessa o chamado.
   - **Waiting for Artifact Approval**, se a análise estiver completa.
   - **Automation Error**, se o worker falhar.

### Workflow 2 — Desenvolvimento (`/lovable/develop`)

1. Busca chamados em **Waiting for Development**. Esse status é colocado manualmente por uma pessoa depois de aprovar os artefatos.
2. Processa **um chamado por execução**. Os requisitos vêm do snapshot aprovado no Workflow 1 (ou, em chamados antigos sem snapshot, da última nota humana).
3. Se for um retrabalho, inclui no prompt o feedback da última revisão reprovada (Workflow 3), para o agente corrigir exatamente o que foi apontado.
4. **Limite de 3 tentativas**: ao atingir o limite, o chamado vai para **Automation Error** com instruções para revisão manual. Isso evita loop infinito entre desenvolvimento e revisão e gasto descontrolado de cota.
5. Marca **Under Development** e chama o worker. O Claude Code envia a implementação ao Lovable, seguindo regras como não mexer em funcionalidades não relacionadas, manter o layout e não reverter arquivos gerenciados pela plataforma. Depois ele confere o diff.
6. O n8n grava resumo, arquivos alterados e diff na nota, incrementa o contador de tentativas e move o chamado para **Waiting for Tests**. Também pode ir para **Waiting for Artifact Approval**, se os requisitos estiverem insuficientes, ou para **Automation Error**, em caso de falha.

### Workflow 3 — Revisão automatizada (`/lovable/review`)

1. Busca chamados em **Waiting for Tests** e marca como **Under Testing**.
2. Envia ao worker os requisitos, que vêm da última nota humana do chamado.
3. O Claude Code faz uma **revisão estática** do código e do diff no Lovable, com **acesso somente leitura**. A ferramenta de envio de mensagens não é liberada, então a revisão não consegue alterar o projeto. Ele verifica se os requisitos foram implementados por completo e se houve alterações fora do escopo. Mudanças feitas pela própria plataforma, como migrações Drizzle e arquivos gerados, não são tratadas como problema.
4. Resultado:
   - **aprovado**: o chamado vai para **Waiting for Tests Approval**, para aprovação humana;
   - **reprovado**: o chamado volta para **Under Development**, com uma nota de "ajustes necessários" que o Workflow 2 usa no próximo ciclo;
   - **falha**: o chamado vai para **Automation Error**.

### Workflow 4 — Error handler

Configurado como *Error Workflow* dos demais. Se qualquer workflow falhar no
meio da execução, ele libera a trava global.

### Controle de concorrência

Todos os workflows compartilham o mesmo worker e a mesma sessão do Claude Code. Por isso existem duas proteções:

- **Trava global no n8n**: Data Table `automation_lock`. Só um dos workflows 1, 2 ou 3 roda por vez. Uma trava com mais de 30 minutos é considerada abandonada e pode ser reassumida.
- **Fila FIFO no worker**: mesmo que cheguem várias requisições, só um processo `claude` roda por vez.

## Estrutura do repositório

```
.
├── worker/            # Servidor Node.js que recebe as chamadas do n8n e executa o Claude Code
├── n8n-workflows/     # Exportações dos 4 workflows do n8n
└── scripts/           # Script para iniciar o túnel ngrok e o worker no Windows
```

## Configuração do Redmine

Os workflows usam IDs fixos de status e de campos customizados. Ajuste nos
Code nodes se a sua instalação usar outros IDs.

| Status | ID |   | Campo customizado | ID |
| --- | --- | --- | --- | --- |
| New | 1 | | AI Processing Required | 1 |
| Under Analysis | 2 | | Latest Artifacts Snapshot (JSON) | 5 |
| Waiting for Artifact Approval | 4 | | Development Attempts | 6 |
| Under Development | 5 | | Perguntas em aberto (texto pt-BR) | 7 |
| Waiting for Tests | 6 | | | |
| Under Testing | 7 | | | |
| Waiting for Tests Approval | 8 | | | |
| Automation Error | 11 | | | |
| Waiting for Answers | 13 | | | |
| Questions Answered | 14 | | | |
| Waiting for Development | 15 | | | |

## Como rodar

### Pré-requisitos

- Node.js 18+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) instalado e autenticado, com o conector do **Lovable** habilitado na conta claude.ai (detalhes em [`worker/README.md`](worker/README.md))
- n8n (ex.: via Docker) e uma instância do Redmine com a API REST habilitada
- (opcional) [ngrok](https://ngrok.com/) para expor o Redmine

### 1. Worker

```powershell
cd worker
npm install
copy .env.example .env   # e preencha os valores
npm start
```

### 2. Workflows do n8n

1. No n8n, crie duas credenciais do tipo **Header Auth**:
   - **Redmine API**: header `X-Redmine-API-Key` com a sua chave do Redmine;
   - **Worker API Key**: header `x-api-key` com o mesmo valor de `WORKER_API_KEY` do `.env`.
2. Crie a Data Table `automation_lock` com as colunas `lock_name`, `status`, `locked_by` e `locked_at`, e uma linha com `lock_name = global` e `status = idle`.
3. Importe os arquivos de `n8n-workflows/`. Em cada node HTTP, selecione as credenciais criadas (os arquivos vêm com IDs `REPLACE_WITH_YOUR_..._CREDENTIAL_ID`).
4. Nos workflows 2 e 3, troque `NOME_DO_SEU_PROJETO_NO_LOVABLE` pelo nome do seu projeto no Lovable.
5. Defina o Workflow 4 como *Error Workflow* dos workflows 1, 2 e 3 e ative os quatro.

### 3. Script de inicialização (Windows)

Edite `NGROK_DOMAIN` em `scripts/iniciar-tunel-e-worker.bat` e execute-o.
Ele abre o túnel ngrok e o worker, cada um em sua própria janela.
