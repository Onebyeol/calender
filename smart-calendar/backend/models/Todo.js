const mongoose = require('mongoose');

const todoSchema = new mongoose.Schema(
  {
    // 소유자. null이면 로그인 없이 만들어진 게스트 데이터 (Notice.js의 설명과 동일)
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    noticeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notice',
      default: null,
    },
    title: {
      type: String,
      required: true,
    },
    due: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    done: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Todo', todoSchema);
