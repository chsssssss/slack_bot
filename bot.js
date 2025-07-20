require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const { App } = require("@slack/bolt");
const express = require("express");
const bodyParser = require("body-parser");
const appServer = express();

const messages = [
  "오늘도 잘 해내고 있어요! 💪",
  "지금 이 순간도 성장 중입니다 🌱",
  "당신의 노력을 응원해요! 🙌",
  "쉬어가도 괜찮아요. 천천히 가도 돼요 🍀",
  "오늘 하루도 수고 많았어요 🌇",
];

// 🧠 감정 메시지 생성
const messagesByPhase = {
  early: [
    "새로운 시작! 여러분의 첫걸음을 응원해요 🚀",
    "처음은 언제나 설레죠! 잘 하고 있어요 😊",
  ],
  mid: [
    "지금이 가장 중요한 시기! 함께 버텨봐요 💪",
    "고비는 곧 기회! 조금만 더 힘내요 🔥",
  ],
  late: [
    "마무리가 가까워졌어요! 끝까지 응원할게요 🏁",
    "지금까지 잘 해온 것처럼, 마지막까지도 잘 할 거예요 ✨",
  ],
};

const timeMessages = {
  morning: [
    "좋은 아침이에요! 오늘도 힘내요 ☀️",
    "기분 좋은 하루의 시작, 함께 열어요 🌼",
  ],
  afternoon: [
    "점심 먹고 나른할 때, 잠깐 스트레칭 어떠세요? 🤸",
    "오늘 하루도 반 넘었어요! 남은 시간도 화이팅 💫",
  ],
  evening: ["오늘 하루도 수고 많았어요 🌙", "하루 마무리 잘하고 푹 쉬세요 😴"],
};

const weeklyMessages = {
  0: ["일요일은 충전하는 날! 푹 쉬어주세요 🔋"],
  1: ["월요일! 새로운 한 주도 파이팅입니다 🔥"],
  2: ["화요일엔 리듬을 타보세요! 🎵"],
  3: ["수요일, 벌써 절반 왔어요 🐫"],
  4: ["목요일은 주말이 보이기 시작하는 날 👀"],
  5: ["금요일이에요! 한 주 고생 많았어요 🎉"],
  6: ["주말 잘 보내고 있나요? 토닥토닥 🤗"],
};

// 캠프 주차 계산
function getCampWeek() {
  const startDate = new Date(process.env.CAMP_START_DATE || "2025-07-01");
  const now = new Date();
  const diffDays = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;
  return week < 1 ? 1 : week;
}

function getEncouragement(week) {
  if (week <= 2)
    return `지금은 캠프 ${week}주차! 아직은 적응 중이에요 💫\n잘하고 있어요, 처음이 제일 어렵죠!`;
  if (week <= 5)
    return `벌써 ${week}주차! 중반을 넘고 있어요 💪\n지금이 가장 중요한 시기, 조금만 더 힘내요!`;
  return `캠프 ${week}주차🎉 마지막 스퍼트 구간이에요!\n여기까지 온 당신이 자랑스러워요 👏`;
}

function getCampPhase() {
  const startDate = new Date("2025-07-01");
  const now = new Date();
  const diffDays = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;

  if (week <= 2) return "early";
  if (week <= 5) return "mid";
  return "late";
}

function getTimeOfDay(hour) {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function getCustomMessage() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday

  const time = getTimeOfDay(hour);
  const phase = getCampPhase();

  const timeMsg = timeMessages[time];
  const phaseMsg = messagesByPhase[phase];
  const weekMsg = weeklyMessages[day] || [];

  // 메시지 무작위로 섞기
  const allCandidates = [...timeMsg, ...phaseMsg, ...weekMsg];

  return allCandidates[Math.floor(Math.random() * allCandidates.length)];
}

// 📊 리액션/답글 통계 가져오기
async function fetchMessageStats(channel, ts, token) {
  try {
    const [reactionRes, repliesRes] = await Promise.all([
      axios.get("https://slack.com/api/reactions.get", {
        params: { channel, timestamp: ts },
        headers: { Authorization: `Bearer ${token}` },
      }),
      axios.get("https://slack.com/api/conversations.replies", {
        params: { channel, ts },
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    const reactionCount =
      reactionRes.data.message?.reactions?.reduce(
        (sum, r) => sum + r.count,
        0
      ) || 0;
    const replyCount = repliesRes.data?.messages?.length - 1 || 0;

    return { reactionCount, replyCount };
  } catch (err) {
    console.error("📛 Error fetching message stats:", err.message);
    return { reactionCount: 0, replyCount: 0 };
  }
}

function formatSummary(logs) {
  return logs
    .map((log, i) => {
      return `• ${i + 1}. "${log.text}"\n   🔁 ${
        log.reactions
      } reactions / 💬 ${log.replies} replies`;
    })
    .join("\n\n");
}

function getTodayLogs(allLogs) {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  return allLogs.filter((log) => log.date.startsWith(today));
}

function getTopMessages(logs, topN = 3) {
  return logs
    .map((log) => ({
      ...log,
      score: log.reactions + log.replies,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

async function sendSummaryToSlack() {
  const token = process.env.SLACK_TOKEN;
  const channel = process.env.CHANNEL_ID;

  const logs = fs.existsSync("reaction-log.json")
    ? JSON.parse(fs.readFileSync("reaction-log.json", "utf-8"))
    : [];

  const todayLogs = getTodayLogs(logs);
  const bestAllTime = getTopMessages(logs);
  const bestToday = getTopMessages(todayLogs);

  const bestText = `\n\n🏆 *역대 반응 좋은 메시지 TOP ${
    bestAllTime.length
  }*\n\n${formatSummary(bestAllTime)}`;

  // 슬랙 전송
  try {
    await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel,
        text: `${bestText}`,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📤 Summary sent to Slack");

    // best-messages.json 저장
    fs.writeFileSync(
      "best-messages.json",
      JSON.stringify(bestAllTime, null, 2)
    );
    console.log("✅ Best messages saved");
  } catch (err) {
    console.error("📛 Failed to send summary:", err.message);
  }
}

// 📩 슬랙 메시지 전송 및 반응 통계 저장
async function sendSlackMessage() {
  const token = process.env.SLACK_TOKEN;
  const channel = process.env.CHANNEL_ID;
  const text = getCustomMessage();

  try {
    const res = await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel, text },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const ts = res.data.ts;
    console.log(`[${new Date().toISOString()}] Sent message: ${text}`);

    if (ts) {
      // 10초 후에 반응 통계를 가져옴
      setTimeout(async () => {
        const stats = await fetchMessageStats(channel, ts, token);

        const logEntry = {
          date: new Date().toISOString(),
          text,
          reactions: stats.reactionCount,
          replies: stats.replyCount,
        };

        const existingLogs = fs.existsSync("reaction-log.json")
          ? JSON.parse(fs.readFileSync("reaction-log.json", "utf-8"))
          : [];

        existingLogs.push(logEntry);
        fs.writeFileSync(
          "reaction-log.json",
          JSON.stringify(existingLogs, null, 2)
        );

        console.log("✅ Reaction stats saved:", logEntry);
      }, 10000);
    }
  } catch (err) {
    console.error("📛 Message sending failed:", err.message);
  }
}

// 🕒 매일 14시, 18시에 실행
cron.schedule("0 12,13,18,22 * * *", sendSlackMessage);

// 매일 오후 9시에 요약 보고 전송
cron.schedule("0 21 * * *", sendSummaryToSlack);

// 📦 앱 실행 시 즉시 1회 실행
// sendSlackMessage();
// sendSummaryToSlack();

// ===============================
// ⚡ 리액션 실시간 감지 (Socket Mode)
// ===============================
const app = new App({
  token: process.env.SLACK_TOKEN, // Bot User OAuth Token
  appToken: process.env.SLACK_APP_TOKEN, // App-level Token (xapp-...)
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

// 👀 리액션 이벤트 감지
app.event("reaction_added", async ({ event, client }) => {
  try {
    const { channel, ts } = event.item;

    // 메시지 가져오기
    const result = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });

    const message = result.messages[0];

    const logEntry = {
      date: new Date().toISOString(),
      text: message.text,
      user: event.user,
      reaction: event.reaction,
      ts,
    };

    const existing = fs.existsSync("reaction-events.json")
      ? JSON.parse(fs.readFileSync("reaction-events.json", "utf-8"))
      : [];

    existing.push(logEntry);
    fs.writeFileSync("reaction-events.json", JSON.stringify(existing, null, 2));

    console.log("💬 리액션 감지됨:", logEntry);
  } catch (err) {
    console.error("❌ 리액션 감지 에러:", err.message);
  }
});

// 🔹 `/토닥` 명령어 핸들링
app.command("/토닥", async ({ command, ack, respond }) => {
  await ack();

  const week = getCampWeek();
  const msg = getEncouragement(week);

  await respond({
    text: `안녕하세요 <@${command.user_id}>님! 🧸\n${msg}`,
    response_type: "in_channel", // 채널에 공개
  });
});

// 🟢 Socket Mode 앱 실행
(async () => {
  await app.start();
  console.log("⚡ Socket Mode 슬랙 앱 실행 중");
})();
