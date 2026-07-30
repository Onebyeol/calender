const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },
    // 로그인 식별자. 화면에는 "이메일"로 안내하지만, 심사용 계정처럼 짧은 아이디도
    // 그대로 쓸 수 있도록 형식 검사는 라우터에서만 하고 스키마는 문자열로 둔다.
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    // 심사/시연용 계정 표시. true면 로그인할 때마다 샘플 일정이 오늘 날짜 기준으로
    // 다시 채워진다 (demoSeed.js 참고). 일반 사용자 계정은 건드리지 않는다.
    isDemo: {
      type: Boolean,
      default: false,
    },
    // 마지막으로 샘플 데이터를 심은 날짜(YYYY-MM-DD). 날짜가 바뀌면 다시 심는다.
    demoSeededOn: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// 비밀번호 해시는 어떤 API 응답에도 실려나가면 안 된다.
userSchema.methods.toPublic = function () {
  return { id: this._id, name: this.name, email: this.email, isDemo: this.isDemo };
};

module.exports = mongoose.model('User', userSchema);
