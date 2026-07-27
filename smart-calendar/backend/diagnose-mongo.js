// MongoDB 연결 문제를 정확히 진단하기 위한 스크립트
// 실행: cd backend && node diagnose-mongo.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI;

console.log('--- 진단 시작 ---');
console.log('MONGODB_URI 읽힘 여부:', uri ? 'O' : 'X (.env에서 못 읽어옴!)');
if (uri) {
  // 비밀번호는 가려서 출력 (보안)
  console.log('URI 형태:', uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@'));
  console.log('SRV 방식(mongodb+srv://) 여부:', uri.startsWith('mongodb+srv://'));
}

if (!uri) {
  console.log('=> .env 파일이 backend 폴더 안에 있는지, 변수명이 MONGODB_URI가 맞는지 확인하세요.');
  process.exit(1);
}

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 8000 })
  .then(() => {
    console.log('✅ 연결 성공!');
    process.exit(0);
  })
  .catch((err) => {
    console.log('❌ 연결 실패. 상세 에러 전체:');
    console.log(err);
    process.exit(1);
  });
