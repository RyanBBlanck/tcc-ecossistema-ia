# Ecossistema de automação com IA — TCC

Código do ecossistema desenvolvido no meu Trabalho de Conclusão de Curso:
um fluxo que leva um chamado do **Redmine** desde a análise de requisitos até
o desenvolvimento e a revisão, usando **n8n** como orquestrador e
**Claude Code + Lovable** como agentes de IA.

## Visão geral

```
Redmine  <──REST──>  n8n (Docker)  ──HTTP──>  worker (Node.js, Windows)  ──spawn──>  claude -p  ──MCP──>  Lovable
```

| Etapa | Workflow n8n | Endpoint do worker | O que faz |
| --- | --- | --- | --- |
| 1 | `workflow-1-geracao-de-artefatos.json` | `POST /redmine/generate-artifacts` | Lê chamados novos (ou com perguntas respondidas) e gera artefatos de requisitos com o Claude Code. Move o chamado para *Waiting for Artifact Approval* ou *Waiting for Answers*. |
| 2 | `workflow-2-desenvolvimento-lovable.json` | `POST /lovable/develop` | Pega chamados em *Waiting for Development* (após aprovação humana dos artefatos) e implementa a mudança no projeto Lovable. |
| 3 | `workflow-3-revisao-lovable.json` | `POST /lovable/review` | Pega chamados em *Waiting for Tests* e faz uma revisão automatizada do que foi implementado. |
| 4 | `workflow-4-error-handler-liberar-trava.json` | — | Error handler: libera a trava global caso algum workflow falhe no meio. |

Os workflows 1 a 3 usam uma **trava global** (Data Table `automation_lock` do
n8n) para que apenas uma automação rode por vez.

## Estrutura do repositório

```
.
├── worker/            # Servidor Node.js que recebe as chamadas do n8n e aciona o Claude Code
├── n8n-workflows/     # Exportações dos workflows do n8n (importar pelo menu do n8n)
└── scripts/           # Script para iniciar o túnel ngrok e o worker no Windows
```

## Como rodar

### Pré-requisitos

- Node.js 18+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) instalado e autenticado, com o MCP do Lovable conectado
- n8n (ex.: via Docker) e uma instância do Redmine com API REST habilitada
- (opcional) [ngrok](https://ngrok.com/) para expor o Redmine

### 1. Worker

```powershell
cd worker
npm install
copy .env.example .env   # e preencha os valores
npm start
```

Detalhes em [`worker/README.md`](worker/README.md).

### 2. Workflows do n8n

1. No n8n, crie as credenciais do tipo **Header Auth**:
   - **Redmine API**: header `X-Redmine-API-Key` com a sua chave do Redmine;
   - **Worker API Key**: header `x-api-key` com o mesmo valor de `WORKER_API_KEY` do `.env`.
2. Crie a Data Table `automation_lock`.
3. Importe os arquivos de `n8n-workflows/` e, em cada node HTTP, selecione as credenciais criadas
   (os arquivos vêm com IDs `REPLACE_WITH_YOUR_..._CREDENTIAL_ID`).
4. Nos workflows 2 e 3, troque `NOME_DO_SEU_PROJETO_NO_LOVABLE` pelo nome do seu projeto no Lovable.
5. Confira os IDs de status do Redmine usados nos Code nodes (`STATUS_...`); eles variam de instalação para instalação.
6. Configure o workflow 4 como *Error Workflow* dos demais.

### 3. Script de inicialização (Windows)

Edite `NGROK_DOMAIN` em `scripts/iniciar-tunel-e-worker.bat` e execute-o
para abrir o túnel ngrok e o worker, cada um em sua janela.
