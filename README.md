# LangCard

LangCard is a web service for learning words with flashcards in classes. Teachers make classes and word sets and assign them, and students join a class with a code and study in five modes.

## Running it

Requires Node.js 22.13 or later. There are no external packages to install, because it uses the built-in `node:sqlite`.

```bash
npm start          # http://localhost:3000
npm test           # API tests
```

| Environment variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `3000` |
| `DB_FILE` | SQLite file path | `data/langcard.db` |
| `SEED_STUDENT_PASSWORD` | Overrides the default student account's password (first run only) | — |
| `SEED_TEACHER_PASSWORD` | Default teacher account's password (first run only) | `teacher1234` |

### Default accounts (created automatically on first run)

| Role | ID | Notes |
| --- | --- | --- |
| Student | `alitatest` | Already in the "중1 영어반" class. The password is stored in the code only as a scrypt hash |
| Teacher | `teacher` | Password `teacher1234`. Class code `ENG101` |

## Features

- **Accounts**: Students and teachers can sign up and log in. Sessions use HttpOnly cookies and passwords are hashed with scrypt.
- **Classes**: Teachers create classes, which generates a join code. Teachers can assign or unassign sets and remove members. Students join with a code or leave a class.
- **Word sets**: Each card has a word, meaning, and example sentence. You can paste many cards at once (tab, comma, or `=` separated, including straight from Excel), edit them, and delete them.
- **Study modes**
  - **Memorize**: Flip the card and answer "I know it" or "I don't". Unknown words repeat in later rounds. Keys: Space, ←, →
  - **Recall**: See a word and pick its meaning from 4 choices. Missed words come back a little later. Keys: 1–4
  - **Spell**: See the meaning and type the word, with a hint that reveals letters one at a time.
  - **Matching game**: Match 6 pairs. Each mistake adds a 1-second penalty, and your record goes on the class ranking.
  - **Test**: Up to 20 questions mixing multiple choice (word→meaning, meaning→word) and spelling, with review of wrong answers afterward.
- **Progress tracking**: Tracks which words you know, your best score and record per mode, and your recent study history. Teachers can see each student's progress on the class's **학습 현황** (progress) page.
- **Pronunciation**: Uses the browser's speech synthesis (Web Speech API).

## Structure

```
server.js        HTTP server + REST API (no dependencies)
db.js            SQLite schema, password hashing, initial data
public/          Single-page front end (index.html, app.js, style.css)
test/            API tests using node:test
```

## Deployment (Render)

1. Sign in to [render.com](https://render.com) with your GitHub account.
2. In the dashboard, go to **New → Blueprint**, select the `masteralita/langcard` repository, and choose the branch to deploy.
3. Render reads `render.yaml` and creates the service automatically. When it finishes you get an address like `https://langcard-xxxx.onrender.com`.
4. The teacher account's password is generated randomly. You can check it under the service's **Environment** tab, in `SEED_TEACHER_PASSWORD`.

> On the free plan, the server sleeps after 15 minutes of inactivity, so the first visit can take 30–60 seconds. Data is reset on every redeploy or restart.
> To keep data, switch to the Starter plan and enable the `disk` setting in `render.yaml`.

You can also run it with Docker: `docker build -t langcard . && docker run -p 3000:3000 -v langcard-data:/data langcard`
