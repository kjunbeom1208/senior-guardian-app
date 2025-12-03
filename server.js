// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

import { SolapiMessageService } from "solapi"; // 👈 named import (구조 분해 할당) 방식


dotenv.config();


const app = express();
app.use(cors());
app.use(bodyParser.json());


// ✅ MySQL 연결 풀 (Railway 값 직접 넣음)
const db = await mysql.createPool({
  host: "yamabiko.proxy.rlwy.net",
  user: "root",
  password: "LiSpdcnPQeHnJvNBpvgwcylNnKhraRNg",
  database: "railway",
  port: 23480,
});


const messageService = new SolapiMessageService(
  process.env.COOLSMS_API_KEYS,
  process.env.COOLSMS_API_SECRET
);

// ✅ 메시지 검사 API (3테이블 기반)
app.post("/api/check-message", async (req, res) => {
  const { message } = req.body;
  let risk = "안전";

  try {
    // 1️⃣ 사기 키워드 검사 (DB)
    const [keywords] = await db.query("SELECT keyword FROM scam_keywords");
    if (keywords.some(row => message.includes(row.keyword))) {
      risk = "위험";
    }

    
    const [phones] = await db.query("SELECT value FROM scam_sources WHERE type='phone'");
    const normalizedMessage = message.replace(/[^0-9]/g, ""); 
    if (phones.some(row => normalizedMessage.includes(row.value.replace(/[^0-9]/g, "")))) {
      risk = "위험";
    }

    const [accounts] = await db.query("SELECT value FROM scam_sources WHERE type='account'");
    if (accounts.some(row => message.includes(row.value))) {
      risk = "위험";
    }



// ✅ 위험이면 DB에 있는 모든 가족 번호로 문자 발송
    if (risk === "위험") {
      const [familyContacts] = await db.query("SELECT phone FROM family_contacts");

      for (let f of familyContacts) {
        try {
          await messageService.sendOne({
            to: f.phone,
            from: process.env.COOLSMS_SENDER,
            text: `🚨 [경고] 위험 메시지 감지됨: ${message}`,
          });
          console.log(`📨 ${f.phone} 보호자에게 전송 성공`);
        } catch (smsErr) {
          console.error(`❌ ${f.phone} 전송 실패:`, smsErr.message);
        }
      }
    }
    res.json({ message, risk });
  } catch (err) {
    console.error("❌ DB 조회 오류:", err);
    res.status(500).json({ error: "DB 조회 오류" });
  }
});

// ✅ 사용자 신고 API
app.post("/api/report", async (req, res) => {
  const { type, value } = req.body;

  if (!type || !value) {
    return res.status(400).json({ success: false, message: "타입과 값을 입력해야 합니다." });
  }
  
  // 1. 값 정규화: 숫자만 남김
  const normalizedValue = value.replace(/[^0-9]/g, "");
  
  // 2. DB에 사용할 최종 값 결정: 'phone' 또는 'account' 타입일 때만 정규화된 값 사용
  const reportValue = (type === 'phone' || type === 'account') ? normalizedValue : value; 
  
  try {
    // 1️⃣ 신고 테이블에서 조회 (수정됨: reportValue 사용)
    const [rows] = await db.query("SELECT * FROM scam_reports WHERE type = ? AND value = ?", [type, reportValue]);

    if (rows.length > 0) {
      // 이미 존재하면 카운트 증가
      const newCount = rows[0].report_count + 1;
      // 카운트 증가 업데이트 (수정 불필요)
      await db.query("UPDATE scam_reports SET report_count = ? WHERE id = ?", [newCount, rows[0].id]);

      // 5회 이상 신고 시 scam_sources에 저장 (수정됨: reportValue 사용)
      if (newCount >= 5) {
        await db.query("INSERT IGNORE INTO scam_sources (type, value) VALUES (?, ?)", [type, reportValue]);
        return res.json({ success: true, message: "🚨 5회 이상 신고되어 위험 데이터베이스에 등록되었습니다!" });
      }

      return res.json({ success: true, message: `✅ 신고 접수됨 (누적 ${newCount}회)` });
    } else {
      // 신규 신고라면 추가 (수정됨: reportValue 사용)
      await db.query("INSERT INTO scam_reports (type, value) VALUES (?, ?)", [type, reportValue]);
      return res.json({ success: true, message: "✅ 신고 접수됨 (누적 1회)" });
    }
  } catch (err) {
    console.error("❌ 신고 저장 오류:", err);
    res.status(500).json({ success: false, message: "DB 저장 실패" });
  }
});

// ✅ 가족 연락처 저장 API
app.post("/api/save-family", async (req, res) => {
  const { phone } = req.body;

  // 1. 값 유효성 검사
  if (!phone) {
    return res.status(400).json({ success: false, message: "전화번호를 입력해야 합니다." });
  }
  
  // 2. 전화번호 정규화: 하이픈 및 특수문자 제거
  const normalizedPhone = phone.replace(/[^0-9]/g, "");

  // 3. 정규화된 값이 비어있는지 확인
  if (normalizedPhone.length === 0) {
      return res.status(400).json({ success: false, message: "유효한 전화번호 형식이어야 합니다." });
  }

  try {
    // 이미 존재하는지 확인 (수정: normalizedPhone 사용)
    const [rows] = await db.query("SELECT * FROM family_contacts WHERE phone = ?", [normalizedPhone]);

    if (rows.length > 0) {
      return res.json({ success: false, message: "이미 등록된 번호입니다." });
    }

    // 새 번호 저장 (수정: normalizedPhone 사용)
    await db.query("INSERT INTO family_contacts (phone) VALUES (?)", [normalizedPhone]);
    res.json({ success: true, message: "가족 연락처가 저장되었습니다." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB 저장 실패" });
  }
});


// ✅ 시니어의 ‘대신 확인 요청’ 기능
app.post("/api/request-check", async (req, res) => {
  const { message } = req.body; // 시니어가 전달한 의심 문자 내용

  if (!message) {
    return res.status(400).json({ success: false, message: "확인할 메시지가 필요합니다." });
  }

  try {
    // ✅ 보호자 연락처 목록 불러오기
    const [familyContacts] = await db.query("SELECT phone FROM family_contacts");

    // ✅ 보호자에게 문자 전송
    for (let f of familyContacts) {
      try {
        await messageService.sendOne({
          to: f.phone,
          from: process.env.COOLSMS_SENDER,
          text: `📩 시니어가 확인 요청한 메시지입니다:\n"${message}"\n\n※ 실제 송금 전 반드시 확인해주세요.`,
        });
        console.log(`📨 ${f.phone}에게 대신 확인 요청 전송 성공`);
      } catch (smsErr) {
        console.error(`❌ ${f.phone} 전송 실패:`, smsErr.message);
      }
    }

    res.json({ success: true, message: "보호자에게 확인 요청이 전송되었습니다." });
  } catch (err) {
    console.error("❌ 보호자 확인 요청 오류:", err);
    res.status(500).json({ success: false, message: "요청 처리 실패" });
  }
});

// ✅ SMS 보내기 API
app.post("/api/send-sms", async (req, res) => {
  const { to, message } = req.body;

  try {
    const response = await messageService.sendOne({
      to: to,                          // 수신자 번호
      from: process.env.COOLSMS_SENDER, // 발신자 번호
      text: message,                   // 문자 내용
    });

    console.log("📨 SMS 전송 성공:", response);
    res.json({ success: true, response });
  } catch (error) {
    console.error("❌ SMS 전송 실패:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ✅ 서버 실행
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});