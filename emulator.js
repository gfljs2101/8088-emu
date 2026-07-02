// emulator.js
// Extended 8088 CPU emulator core with more opcodes implemented.
// Adds groups: OR/ADC/SBB/AND/XOR/CMP, immediate group opcodes 0x80/81/82/83,
// TEST/NOT/NEG in F6/F7, shifts D0-D3 (basic), INC/DEC r/m (FE/FF),
// MOV r/m8,d8 (C6) and r/m16,d16 (C7), XCHG (86/87), LEA (8D), TEST (84/85),
// MOV segment register forms (8C/8E), POP r/m16 (8F), and more.

class CPU {
  constructor(opts={}) {
    this.mem = new Uint8Array(1<<20); // 1MB physical memory
    this.regs16 = { AX:0, BX:0, CX:0, DX:0, SP:0xFFFE, BP:0, SI:0, DI:0 };
    this.segments = { CS:0, DS:0, ES:0, SS:0 };
    this.IP = 0;
    this.flags = { CF:0, PF:0, AF:0, ZF:0, SF:0, TF:0, IF:0, DF:0, OF:0 };
    this.onConsole = opts.onConsole || ((s)=>console.log(s));
    this.onHalt = opts.onHalt || ((r)=>console.log("HALT",r));
    this.onUpdate = opts.onUpdate || (()=>{});
    this.halted = false;
  }

  reset() {
    this.mem.fill(0);
    for (let k in this.regs16) this.regs16[k] = 0;
    this.regs16.SP = 0xFFFE;
    this.segments = { CS:0, DS:0, ES:0, SS:0 };
    this.IP = 0x0000;
    for (let f in this.flags) this.flags[f] = 0;
    this.halted = false;
  }

  physicalAddr(segment, offset) { return ((segment << 4) + (offset & 0xFFFF)) & 0xFFFFF; }

  read8(physAddr) { return this.mem[physAddr & 0xFFFFF]; }
  write8(physAddr, v) { this.mem[physAddr & 0xFFFFF] = v & 0xFF; }
  read16(physAddr) {
    const lo = this.read8(physAddr);
    const hi = this.read8((physAddr+1)&0xFFFFF);
    return (hi<<8)|lo;
  }
  write16(physAddr, v) {
    this.write8(physAddr, v & 0xFF);
    this.write8((physAddr+1)&0xFFFFF, (v>>8)&0xFF);
  }

  fetch8() {
    const phys = this.physicalAddr(this.segments.CS, this.IP);
    const b = this.read8(phys);
    this.IP = (this.IP + 1) & 0xFFFF;
    return b;
  }
  fetch16() {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return (hi<<8)|lo;
  }

  reg8FromCode(code) {
    switch(code) {
      case 0: return {get:()=>this.regs16.AX & 0xFF, set:(v)=>this.regs16.AX = (this.regs16.AX & 0xFF00) | (v & 0xFF)};
      case 1: return {get:()=>this.regs16.CX & 0xFF, set:(v)=>this.regs16.CX = (this.regs16.CX & 0xFF00) | (v & 0xFF)};
      case 2: return {get:()=>this.regs16.DX & 0xFF, set:(v)=>this.regs16.DX = (this.regs16.DX & 0xFF00) | (v & 0xFF)};
      case 3: return {get:()=>this.regs16.BX & 0xFF, set:(v)=>this.regs16.BX = (this.regs16.BX & 0xFF00) | (v & 0xFF)};
      case 4: return {get:()=> (this.regs16.AX>>8) & 0xFF, set:(v)=>this.regs16.AX = ((v&0xFF)<<8) | (this.regs16.AX & 0x00FF)};
      case 5: return {get:()=> (this.regs16.CX>>8) & 0xFF, set:(v)=>this.regs16.CX = ((v&0xFF)<<8) | (this.regs16.CX & 0x00FF)};
      case 6: return {get:()=> (this.regs16.DX>>8) & 0xFF, set:(v)=>this.regs16.DX = ((v&0xFF)<<8) | (this.regs16.DX & 0x00FF)};
      case 7: return {get:()=> (this.regs16.BX>>8) & 0xFF, set:(v)=>this.regs16.BX = ((v&0xFF)<<8) | (this.regs16.BX & 0x00FF)};
    }
  }
  reg16FromCode(code) {
    switch(code) {
      case 0: return {get:()=>this.regs16.AX, set:(v)=>this.regs16.AX = v & 0xFFFF};
      case 1: return {get:()=>this.regs16.CX, set:(v)=>this.regs16.CX = v & 0xFFFF};
      case 2: return {get:()=>this.regs16.DX, set:(v)=>this.regs16.DX = v & 0xFFFF};
      case 3: return {get:()=>this.regs16.BX, set:(v)=>this.regs16.BX = v & 0xFFFF};
      case 4: return {get:()=>this.regs16.SP, set:(v)=>this.regs16.SP = v & 0xFFFF};
      case 5: return {get:()=>this.regs16.BP, set:(v)=>this.regs16.BP = v & 0xFFFF};
      case 6: return {get:()=>this.regs16.SI, set:(v)=>this.regs16.SI = v & 0xFFFF};
      case 7: return {get:()=>this.regs16.DI, set:(v)=>this.regs16.DI = v & 0xFFFF};
    }
  }

  decodeModRM() {
    const modrm = this.fetch8();
    const mod = (modrm>>6)&3;
    const reg = (modrm>>3)&7;
    const rm  = modrm & 7;
    let disp = 0;
    if (mod===0) {
      if (rm===6) {
        disp = this.fetch16();
        return {mod, reg, rm, disp, ea:disp, seg: this.segments.DS, direct:true};
      }
    } else if (mod===1) {
      const b = this.fetch8();
      disp = (b & 0x80) ? (b|0xFF00) : b;
    } else if (mod===2) {
      disp = this.fetch16();
    }
    const ea = (this.calcEA(rm) + (disp|0)) & 0xFFFF;
    const seg = this.eaUsesSS(rm) ? this.segments.SS : this.segments.DS;
    return {mod, reg, rm, disp, ea, seg, direct:false};
  }

  calcEA(rm) {
    switch(rm) {
      case 0: return (this.regs16.BX + this.regs16.SI) & 0xFFFF;
      case 1: return (this.regs16.BX + this.regs16.DI) & 0xFFFF;
      case 2: return (this.regs16.BP + this.regs16.SI) & 0xFFFF;
      case 3: return (this.regs16.BP + this.regs16.DI) & 0xFFFF;
      case 4: return this.regs16.SI & 0xFFFF;
      case 5: return this.regs16.DI & 0xFFFF;
      case 6: return this.regs16.BP & 0xFFFF;
      case 7: return this.regs16.BX & 0xFFFF;
    }
  }
  eaUsesSS(rm) { return (rm === 2 || rm === 3 || rm === 6); }

  push16(v) {
    this.regs16.SP = (this.regs16.SP - 2) & 0xFFFF;
    const phys = this.physicalAddr(this.segments.SS, this.regs16.SP);
    this.write16(phys, v);
  }
  pop16() {
    const phys = this.physicalAddr(this.segments.SS, this.regs16.SP);
    const v = this.read16(phys);
    this.regs16.SP = (this.regs16.SP + 2) & 0xFFFF;
    return v;
  }

  parity(x) { x = x & 0xFF; let p=0; for (let i=0;i<8;i++) if (x&(1<<i)) p++; return (p%2)===0; }

  updateFlagsAdd8(a,b,res) {
    const r = res & 0xFF;
    this.flags.CF = res > 0xFF ? 1 : 0;
    this.flags.ZF = (r === 0)?1:0;
    this.flags.SF = (r & 0x80) ? 1:0;
    this.flags.PF = this.parity(r)?1:0;
    this.flags.AF = (((a & 0xF) + (b & 0xF)) > 0xF) ? 1:0;
    this.flags.OF = ((((a^b^0x80) & (a^r) & 0x80) !== 0) ? 1:0);
  }
  updateFlagsAdd16(a,b,res) {
    const r = res & 0xFFFF;
    this.flags.CF = res > 0xFFFF ? 1:0;
    this.flags.ZF = (r===0)?1:0;
    this.flags.SF = (r & 0x8000) ?1:0;
    this.flags.PF = this.parity(r & 0xFF)?1:0;
    this.flags.AF = (((a & 0xF) + (b & 0xF)) > 0xF) ? 1:0;
    this.flags.OF = ((((a^b^0x8000) & (a^r) & 0x8000) !== 0) ? 1:0);
  }
  updateFlagsSub8(a,b,res) {
    const r = res & 0xFF;
    this.flags.CF = (res & 0x100) ? 1:0;
    this.flags.ZF = (r===0)?1:0;
    this.flags.SF = (r & 0x80)?1:0;
    this.flags.PF = this.parity(r)?1:0;
    this.flags.AF = (((a & 0xF) - (b & 0xF)) < 0) ? 1:0;
    this.flags.OF = ((((a^b) & (a^r)) & 0x80) !== 0) ? 1:0;
  }
  updateFlagsSub16(a,b,res) {
    const r = res & 0xFFFF;
    this.flags.CF = (res & 0x10000) ? 1:0;
    this.flags.ZF = (r===0)?1:0;
    this.flags.SF = (r & 0x8000)?1:0;
    this.flags.PF = this.parity(r & 0xFF)?1:0;
    this.flags.AF = (((a & 0xF) - (b & 0xF)) < 0) ? 1:0;
    this.flags.OF = ((((a^b) & (a^r)) & 0x8000) !== 0) ? 1:0;
  }

  handleInt(n) {
    if (n === 0x20) { this.halted = true; this.onHalt("INT 20"); return; }
    if (n === 0x21) {
      const ah = (this.regs16.AX >> 8) & 0xFF;
      if (ah === 0x09) {
        let off = this.regs16.DX & 0xFFFF; const seg = this.segments.DS; let s='';
        while (true) { const phys = this.physicalAddr(seg, off); const ch = this.read8(phys); if (ch===0x24) break; s+=String.fromCharCode(ch); off=(off+1)&0xFFFF; }
        this.onConsole(s);
      } else if (ah === 0x02) {
        const c = String.fromCharCode(this.regs16.DX & 0xFF); this.onConsole(c);
      } else { this.onConsole(`[INT21 AH=${ah.toString(16)} not implemented]`); }
      return;
    }
    this.onConsole(`[INT ${n.toString(16)} not implemented]`);
  }

  // Helpers for group ALU operations (opcodes 0x80/81/82/83)
  aluOpByte(op, dest, imm) {
    const a = dest & 0xFF;
    const b = imm & 0xFF;
    switch(op) {
      case 0: { const res = a + b; this.updateFlagsAdd8(a,b,res); return res & 0xFF; }
      case 1: { const res = a | b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=( (res&0xFF)===0)?1:0; this.flags.SF=((res&0x80)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFF; }
      case 2: { const carry = this.flags.CF; const res = a + b + carry; this.updateFlagsAdd8(a,b+carry,res); return res & 0xFF; }
      case 3: { const carry = this.flags.CF; const res = a - b - carry; this.updateFlagsSub8(a,b+carry,res); return res & 0xFF; }
      case 4: { const res = a & b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=((res&0xFF)===0)?1:0; this.flags.SF=((res&0x80)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFF; }
      case 5: { const res = a - b; this.updateFlagsSub8(a,b,res); return res & 0xFF; }
      case 6: { const res = a ^ b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=((res&0xFF)===0)?1:0; this.flags.SF=((res&0x80)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFF; }
      case 7: { const res = a - b; this.updateFlagsSub8(a,b,res); return null; }
    }
  }
  aluOpWord(op, dest, imm) {
    const a = dest & 0xFFFF;
    const b = imm & 0xFFFF;
    switch(op) {
      case 0: { const res = a + b; this.updateFlagsAdd16(a,b,res); return res & 0xFFFF; }
      case 1: { const res = a | b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=( (res&0xFFFF)===0)?1:0; this.flags.SF=((res&0x8000)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFFFF; }
      case 2: { const carry = this.flags.CF; const res = a + b + carry; this.updateFlagsAdd16(a,b+carry,res); return res & 0xFFFF; }
      case 3: { const carry = this.flags.CF; const res = a - b - carry; this.updateFlagsSub16(a,b+carry,res); return res & 0xFFFF; }
      case 4: { const res = a & b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=((res&0xFFFF)===0)?1:0; this.flags.SF=((res&0x8000)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFFFF; }
      case 5: { const res = a - b; this.updateFlagsSub16(a,b,res); return res & 0xFFFF; }
      case 6: { const res = a ^ b; this.flags.CF=0; this.flags.OF=0; this.flags.ZF=((res&0xFFFF)===0)?1:0; this.flags.SF=((res&0x8000)?1:0); this.flags.PF=this.parity(res&0xFF)?1:0; return res & 0xFFFF; }
      case 7: { const res = a - b; this.updateFlagsSub16(a,b,res); return null; }
    }
  }

  // Shifts/rotates (basic implementation for 1 or CL)
  rol8(v,n) { n &= 7; return ((v<<n) | (v>>(8-n))) & 0xFF; }
  rol16(v,n) { n &= 15; return ((v<<n) | (v>>(16-n))) & 0xFFFF; }
  ror8(v,n) { n &= 7; return ((v>>n) | ((v<<(8-n))&0xFF)) & 0xFF; }
  ror16(v,n) { n &= 15; return ((v>>n) | ((v<<(16-n))&0xFFFF)) & 0xFFFF; }

  step() {
    if (this.halted) return;
    const op = this.fetch8();
    switch(op) {
      case 0x90: break; // NOP

      // MOV r/m8, r8   0x88
      case 0x88: {
        const m = this.decodeModRM();
        const r = this.reg8FromCode(m.reg).get();
        if (m.mod === 3) { const dest = this.reg8FromCode(m.rm); dest.set(r); }
        else { const phys = this.physicalAddr(m.seg, m.ea); this.write8(phys, r); }
        break;
      }
      // MOV r/m16, r16 0x89
      case 0x89: {
        const m = this.decodeModRM(); const r16 = this.reg16FromCode(m.reg).get();
        if (m.mod === 3) { const dest = this.reg16FromCode(m.rm); dest.set(r16); }
        else { const phys = this.physicalAddr(m.seg, m.ea); this.write16(phys, r16); }
        break;
      }
      // MOV r8, r/m8 0x8A
      case 0x8A: {
        const m = this.decodeModRM();
        if (m.mod === 3) { const val = this.reg8FromCode(m.rm).get(); this.reg8FromCode(m.reg).set(val); }
        else { const phys = this.physicalAddr(m.seg, m.ea); const val = this.read8(phys); this.reg8FromCode(m.reg).set(val); }
        break;
      }
      // MOV r16, r/m16 0x8B
      case 0x8B: {
        const m = this.decodeModRM();
        if (m.mod === 3) { const val = this.reg16FromCode(m.rm).get(); this.reg16FromCode(m.reg).set(val); }
        else { const phys = this.physicalAddr(m.seg, m.ea); const val = this.read16(phys); this.reg16FromCode(m.reg).set(val); }
        break;
      }

      // XCHG r/m8,r8 0x86  and XCHG r/m16,r16 0x87
      case 0x86: {
        const m = this.decodeModRM();
        if (m.mod === 3) {
          const a = this.reg8FromCode(m.reg).get();
          const b = this.reg8FromCode(m.rm).get();
          this.reg8FromCode(m.reg).set(b); this.reg8FromCode(m.rm).set(a);
        } else {
          const phys = this.physicalAddr(m.seg, m.ea);
          const a = this.reg8FromCode(m.reg).get(); const b = this.read8(phys);
          this.write8(phys, a); this.reg8FromCode(m.reg).set(b);
        }
        break;
      }
      case 0x87: {
        const m = this.decodeModRM();
        if (m.mod === 3) {
          const a = this.reg16FromCode(m.reg).get(); const b = this.reg16FromCode(m.rm).get();
          this.reg16FromCode(m.reg).set(b); this.reg16FromCode(m.rm).set(a);
        } else {
          const phys = this.physicalAddr(m.seg, m.ea);
          const a = this.reg16FromCode(m.reg).get(); const b = this.read16(phys);
          this.write16(phys, a); this.reg16FromCode(m.reg).set(b);
        }
        break;
      }

      // TEST r/m8,r8 0x84  TEST r/m16,r16 0x85
      case 0x84: {
        const m = this.decodeModRM(); let a=0,b=0;
        if (m.mod===3) { a = this.reg8FromCode(m.reg).get(); b = this.reg8FromCode(m.rm).get(); }
        else { a = this.reg8FromCode(m.reg).get(); b = this.read8(this.physicalAddr(m.seg,m.ea)); }
        const res = (a & b) & 0xFF; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x80)?1:0; this.flags.PF = this.parity(res)?1:0; this.flags.CF=0; this.flags.OF=0;
        break;
      }
      case 0x85: {
        const m = this.decodeModRM(); let a=0,b=0;
        if (m.mod===3) { a = this.reg16FromCode(m.reg).get(); b = this.reg16FromCode(m.rm).get(); }
        else { a = this.reg16FromCode(m.reg).get(); b = this.read16(this.physicalAddr(m.seg,m.ea)); }
        const res = (a & b) & 0xFFFF; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x8000)?1:0; this.flags.PF = this.parity(res & 0xFF)?1:0; this.flags.CF=0; this.flags.OF=0;
        break;
      }

      // LEA r16, m 0x8D
      case 0x8D: {
        const m = this.decodeModRM();
        const eff = m.ea & 0xFFFF;
        this.reg16FromCode(m.reg).set(eff);
        break;
      }

      // MOV sr, r/m16 0x8E  (load segment reg from r/m16)
      case 0x8E: {
        const m = this.decodeModRM();
        const segIndex = m.reg; // 0=ES,1=CS,2=SS,3=DS per intel
        let val = 0;
        if (m.mod===3) val = this.reg16FromCode(m.rm).get(); else val = this.read16(this.physicalAddr(m.seg,m.ea));
        switch(segIndex) { case 0: this.segments.ES = val; break; case 1: this.segments.CS = val; break; case 2: this.segments.SS = val; break; case 3: this.segments.DS = val; break; default: break; }
        break;
      }
      // MOV r/m16, sr 0x8C (store segment reg to r/m16)
      case 0x8C: {
        const m = this.decodeModRM();
        const segIndex = m.reg;
        let val = 0;
        switch(segIndex) { case 0: val = this.segments.ES; break; case 1: val = this.segments.CS; break; case 2: val = this.segments.SS; break; case 3: val = this.segments.DS; break; }
        if (m.mod===3) { this.reg16FromCode(m.rm).set(val); } else { this.write16(this.physicalAddr(m.seg,m.ea), val); }
        break;
      }

      // POP r/m16 0x8F
      case 0x8F: {
        const m = this.decodeModRM();
        const v = this.pop16();
        if (m.mod===3) this.reg16FromCode(m.rm).set(v); else this.write16(this.physicalAddr(m.seg,m.ea), v);
        break;
      }

      // Immediate register/load opcodes B0..BF handled
      default:
        // handle ranges & groups
        if (op >= 0xB0 && op <= 0xB7) { // MOV r8, imm8
          const regcode = op - 0xB0; const imm8 = this.fetch8(); this.reg8FromCode(regcode).set(imm8); }
        else if (op >= 0xB8 && op <= 0xBF) { // MOV r16, imm16
          const regcode = op - 0xB8; const imm16 = this.fetch16(); this.reg16FromCode(regcode).set(imm16); }
        else if (op >= 0x40 && op <= 0x47) { const code = op - 0x40; const a = this.reg16FromCode(code).get(); const res=(a+1)&0xFFFF; this.reg16FromCode(code).set(res); this.flags.ZF=(res===0)?1:0; }
        else if (op >= 0x48 && op <= 0x4F) { const code = op - 0x48; const a = this.reg16FromCode(code).get(); const res=(a-1)&0xFFFF; this.reg16FromCode(code).set(res); this.flags.ZF=(res===0)?1:0; }
        else if (op >= 0x50 && op <= 0x57) { const code = op-0x50; const val = this.reg16FromCode(code).get(); this.push16(val); }
        else if (op >= 0x58 && op <= 0x5F) { const code = op-0x58; const v = this.pop16(); this.reg16FromCode(code).set(v); }
        else if (op === 0xA0) { const addr = this.fetch16(); const phys = this.physicalAddr(this.segments.CS, addr); this.reg8FromCode(0).set(this.read8(phys)); }
        else if (op === 0xA1) { const addr = this.fetch16(); const phys = this.physicalAddr(this.segments.CS, addr); this.reg16FromCode(0).set(this.read16(phys)); }
        else if (op === 0xA2) { const addr = this.fetch16(); const phys = this.physicalAddr(this.segments.CS, addr); this.write8(phys, this.reg8FromCode(0).get()); }
        else if (op === 0xA3) { const addr = this.fetch16(); const phys = this.physicalAddr(this.segments.CS, addr); this.write16(phys, this.reg16FromCode(0).get()); }
        else if (op >= 0x00 && op <= 0x03) {
          // ADD group implemented earlier - handle here for clarity
          if (op === 0x00) {
            const m = this.decodeModRM(); const r = this.reg8FromCode(m.reg).get(); if (m.mod===3) { const a=this.reg8FromCode(m.rm).get(); const res=a+r; this.reg8FromCode(m.rm).set(res&0xFF); }
          else if (op === 0x01) { const m=this.decodeModRM(); const r=this.reg16FromCode(m.reg).get(); if (m.mod===3) { const a=this.reg16FromCode(m.rm).get(); const res=a+r; this.reg16FromCode(m.rm).set(res&0xFFFF); }}
          else if (op === 0x02) { const m=this.decodeModRM(); if (m.mod===3) { const a=this.reg8FromCode(m.reg).get(); const b=this.reg8FromCode(m.rm).get(); const res=a+b; this.reg8FromCode(m.reg).set(res&0xFF); }}
          else if (op === 0x03) { const m=this.decodeModRM(); if (m.mod===3) { const a=this.reg16FromCode(m.reg).get(); const b=this.reg16FromCode(m.rm).get(); const res=a+b; this.reg16FromCode(m.reg).set(res&0xFFFF); }}
        }
        else if (op === 0xEB) { const rel = (this.fetch8()<<24)>>24; this.IP = (this.IP + rel) & 0xFFFF; }
        else if (op === 0xE9) { const rel = (this.fetch16()<<16)>>16; this.IP = (this.IP + rel) & 0xFFFF; }
        else if (op === 0xE8) { const rel = (this.fetch16()<<16)>>16; const returnIP=this.IP&0xFFFF; this.push16(returnIP); this.IP=(this.IP+rel)&0xFFFF; }
        else if (op === 0xC3) { const newIP=this.pop16(); this.IP=newIP&0xFFFF; }
        else if (op === 0xCD) { const n=this.fetch8(); this.handleInt(n); }
        else if (op === 0xC6) {
          // MOV r/m8, imm8
          const m = this.decodeModRM(); const imm = this.fetch8(); if (m.mod===3) this.reg8FromCode(m.rm).set(imm); else this.write8(this.physicalAddr(m.seg,m.ea), imm);
        }
        else if (op === 0xC7) {
          // MOV r/m16, imm16
          const m = this.decodeModRM(); const imm = this.fetch16(); if (m.mod===3) this.reg16FromCode(m.rm).set(imm); else this.write16(this.physicalAddr(m.seg,m.ea), imm);
        }
        else if (op === 0x80 || op === 0x82) {
          // group: ALU byte with imm8 (82 same as 80)
          const m = this.decodeModRM(); const imm = this.fetch8(); const opnum = m.reg;
          if (m.mod===3) {
            const dest = this.reg8FromCode(m.rm).get(); const res = this.aluOpByte(opnum, dest, imm); if (opnum!==7) this.reg8FromCode(m.rm).set(res);
          } else {
            const phys = this.physicalAddr(m.seg,m.ea); const dest = this.read8(phys); const res = this.aluOpByte(opnum,dest,imm); if (opnum!==7) this.write8(phys,res);
          }
        }
        else if (op === 0x81) {
          // group: ALU word with imm16
          const m = this.decodeModRM(); const imm16 = this.fetch16(); const opnum = m.reg;
          if (m.mod===3) { const dest = this.reg16FromCode(m.rm).get(); const res = this.aluOpWord(opnum,dest,imm16); if (opnum!==7) this.reg16FromCode(m.rm).set(res); }
          else { const phys = this.physicalAddr(m.seg,m.ea); const dest=this.read16(phys); const res=this.aluOpWord(opnum,dest,imm16); if (opnum!==7) this.write16(phys,res); }
        }
        else if (op === 0x83) {
          // group: ALU word with sign-extended imm8
          const m = this.decodeModRM(); const imm8 = this.fetch8(); const imm16 = (imm8<<24)>>24; const opnum=m.reg;
          if (m.mod===3) { const dest=this.reg16FromCode(m.rm).get(); const res=this.aluOpWord(opnum,dest,imm16); if (opnum!==7) this.reg16FromCode(m.rm).set(res); }
          else { const phys=this.physicalAddr(m.seg,m.ea); const dest=this.read16(phys); const res=this.aluOpWord(opnum,dest,imm16); if (opnum!==7) this.write16(phys,res); }
        }
        else if (op === 0xD0 || op === 0xD1 || op === 0xD2 || op === 0xD3) {
          // rotate/shift group
          const m = this.decodeModRM(); const count = (op===0xD0||op===0xD1)?1:(this.regs16.CX & 0xFF);
          const code = m.reg; // 0:ROL,1:ROR,2:RCL,3:RCR,4:SHL,5:SHR,6:*SAL (same as SHL),7:SAR
          if (op===0xD0 || op===0xD2) { // byte
            if (m.mod===3) {
              let v = this.reg8FromCode(m.rm).get();
              if (code===0) v = this.rol8(v,count);
              else if (code===1) v = this.ror8(v,count);
              else if (code===4||code===6) v = (v<<count)&0xFF;
              else if (code===5) v = (v>>>count)&0xFF;
              else if (code===7) v = ( (v>>count) & 0xFF );
              this.reg8FromCode(m.rm).set(v);
            } else {
              const phys=this.physicalAddr(m.seg,m.ea); let v=this.read8(phys);
              if (code===0) v=this.rol8(v,count); else if (code===1) v=this.ror8(v,count); else if (code===4||code===6) v=(v<<count)&0xFF; else if (code===5) v=(v>>>count)&0xFF; else if (code===7) v=((v>>count)&0xFF);
              this.write8(phys,v);
            }
          } else {
            // word
            if (m.mod===3) {
              let v = this.reg16FromCode(m.rm).get();
              if (code===0) v = this.rol16(v,count);
              else if (code===1) v = this.ror16(v,count);
              else if (code===4||code===6) v = (v<<count)&0xFFFF;
              else if (code===5) v = (v>>>count)&0xFFFF;
              else if (code===7) v = ((v>>count)&0xFFFF);
              this.reg16FromCode(m.rm).set(v);
            } else {
              const phys=this.physicalAddr(m.seg,m.ea); let v=this.read16(phys);
              if (code===0) v=this.rol16(v,count); else if (code===1) v=this.ror16(v,count); else if (code===4||code===6) v=(v<<count)&0xFFFF; else if (code===5) v=(v>>>count)&0xFFFF; else if (code===7) v=((v>>count)&0xFFFF);
              this.write16(phys,v);
            }
          }
        }
        else if (op === 0xF6 || op === 0xF7) {
          // ALU2 group: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV
          const m = this.decodeModRM(); const code = m.reg;
          if (op===0xF6) {
            // byte
            if (code === 0) {
              const imm = this.fetch8(); const val = (m.mod===3)?this.reg8FromCode(m.rm).get():this.read8(this.physicalAddr(m.seg,m.ea)); const res = val & imm; this.flags.ZF=(res===0)?1:0; this.flags.SF=(res&0x80)?1:0; this.flags.PF=this.parity(res&0xFF)?1:0; this.flags.CF=0; this.flags.OF=0;
            } else if (code === 2) {
              // NOT
              if (m.mod===3) { const v=this.reg8FromCode(m.rm).get(); this.reg8FromCode(m.rm).set((~v)&0xFF); } else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read8(phys); this.write8(phys, (~v)&0xFF); }
            } else if (code === 3) {
              // NEG
              if (m.mod===3) { const v=this.reg8FromCode(m.rm).get(); const res = (0 - v) & 0xFF; this.reg8FromCode(m.rm).set(res); this.updateFlagsSub8(0,v,0-v); } else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read8(phys); const res=(0-v)&0xFF; this.write8(phys,res); this.updateFlagsSub8(0,v,0-v); }
            } else {
              this.onConsole(`[F6 group op ${code} unimplemented]`);
            }
          } else {
            // word (F7)
            if (code === 0) {
              const imm = this.fetch16(); const val = (m.mod===3)?this.reg16FromCode(m.rm).get():this.read16(this.physicalAddr(m.seg,m.ea)); const res = val & imm; this.flags.ZF=(res===0)?1:0; this.flags.SF=(res&0x8000)?1:0; this.flags.PF=this.parity(res&0xFF)?1:0; this.flags.CF=0; this.flags.OF=0;
            } else if (code === 2) {
              if (m.mod===3) { const v=this.reg16FromCode(m.rm).get(); this.reg16FromCode(m.rm).set((~v)&0xFFFF); } else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read16(phys); this.write16(phys, (~v)&0xFFFF); }
            } else if (code === 3) {
              if (m.mod===3) { const v=this.reg16FromCode(m.rm).get(); const res=(0-v)&0xFFFF; this.reg16FromCode(m.rm).set(res); this.updateFlagsSub16(0,v,0-v); } else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read16(phys); const res=(0-v)&0xFFFF; this.write16(phys,res); this.updateFlagsSub16(0,v,0-v); }
            } else {
              this.onConsole(`[F7 group op ${code} unimplemented]`);
            }
          }
        }
        else if (op === 0xFE || op === 0xFF) {
          // INC/DEC r/m8 or r/m16 and more (FF has calls/jumps/push)
          const m = this.decodeModRM();
          if (op === 0xFE) {
            // INC/DEC r/m8
            if (m.reg === 0) {
              if (m.mod===3) { const v=this.reg8FromCode(m.rm).get(); const r=(v+1)&0xFF; this.reg8FromCode(m.rm).set(r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x80)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
              else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read8(phys); const r=(v+1)&0xFF; this.write8(phys,r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x80)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
            } else if (m.reg === 1) {
              if (m.mod===3) { const v=this.reg8FromCode(m.rm).get(); const r=(v-1)&0xFF; this.reg8FromCode(m.rm).set(r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x80)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
              else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read8(phys); const r=(v-1)&0xFF; this.write8(phys,r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x80)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
            } else { this.onConsole(`[FE group sub-op ${m.reg} unimplemented]`); }
          } else {
            // FF group
            if (m.reg === 0) { // INC r/m16
              if (m.mod===3) { const v=this.reg16FromCode(m.rm).get(); const r=(v+1)&0xFFFF; this.reg16FromCode(m.rm).set(r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x8000)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
              else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read16(phys); const r=(v+1)&0xFFFF; this.write16(phys,r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x8000)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
            } else if (m.reg === 1) { // DEC r/m16
              if (m.mod===3) { const v=this.reg16FromCode(m.rm).get(); const r=(v-1)&0xFFFF; this.reg16FromCode(m.rm).set(r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x8000)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
              else { const phys=this.physicalAddr(m.seg,m.ea); const v=this.read16(phys); const r=(v-1)&0xFFFF; this.write16(phys,r); this.flags.ZF=(r===0)?1:0; this.flags.SF=(r&0x8000)?1:0; this.flags.PF=this.parity(r&0xFF)?1:0; }
            } else if (m.reg === 4) { // CALL r/m16
              let target = 0; if (m.mod===3) target = this.reg16FromCode(m.rm).get(); else target = this.read16(this.physicalAddr(m.seg,m.ea)); this.push16(this.IP); this.IP = target & 0xFFFF;
            } else if (m.reg === 6) { // PUSH r/m16
              let v = 0; if (m.mod===3) v = this.reg16FromCode(m.rm).get(); else v = this.read16(this.physicalAddr(m.seg,m.ea)); this.push16(v);
            } else { this.onConsole(`[FF group sub-op ${m.reg} not fully implemented]`); }
          }
        }
        else if (op === 0x06) { // PUSH ES
          this.push16(this.segments.ES);
        }
        else if (op === 0x07) { // POP ES
          this.segments.ES = this.pop16();
        }
        else if (op === 0x0E) { // PUSH CS
          this.push16(this.segments.CS);
        }
        else if (op === 0x1E) { // PUSH DS
          this.push16(this.segments.DS);
        }
        else if (op === 0x17) { // POP SS (17 is actually POP SS?)
          // Note: POP SS is privileged on some CPUs; for emulator allow it
          this.segments.SS = this.pop16();
        }
        else if (op === 0x30) {
          // XOR r/m8, r8
          const m = this.decodeModRM(); const src = this.reg8FromCode(m.reg).get();
          if (m.mod===3) {
            const dest = this.reg8FromCode(m.rm).get(); const res = (dest ^ src) & 0xFF;
            this.reg8FromCode(m.rm).set(res);
            this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x80)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
          } else {
            const phys = this.physicalAddr(m.seg,m.ea); const dest = this.read8(phys); const res = (dest ^ src) & 0xFF;
            this.write8(phys,res);
            this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x80)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
          }
        }
        else if (op === 0x31) {
          // XOR r/m16, r16
          const m = this.decodeModRM(); const src = this.reg16FromCode(m.reg).get();
          if (m.mod===3) {
            const dest = this.reg16FromCode(m.rm).get(); const res = (dest ^ src) & 0xFFFF;
            this.reg16FromCode(m.rm).set(res);
            this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x8000)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
          } else {
            const phys = this.physicalAddr(m.seg,m.ea); const dest = this.read16(phys); const res = (dest ^ src) & 0xFFFF;
            this.write16(phys,res);
            this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x8000)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
          }
        }
        else if (op === 0x32) {
          // XOR r8, r/m8
          const m = this.decodeModRM(); let src = 0;
          if (m.mod===3) src = this.reg8FromCode(m.rm).get(); else src = this.read8(this.physicalAddr(m.seg,m.ea));
          const dest = this.reg8FromCode(m.reg).get(); const res = (dest ^ src) & 0xFF;
          this.reg8FromCode(m.reg).set(res);
          this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x80)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
        }
        else if (op === 0x33) {
          // XOR r16, r/m16
          const m = this.decodeModRM(); let src = 0;
          if (m.mod===3) src = this.reg16FromCode(m.rm).get(); else src = this.read16(this.physicalAddr(m.seg,m.ea));
          const dest = this.reg16FromCode(m.reg).get(); const res = (dest ^ src) & 0xFFFF;
          this.reg16FromCode(m.reg).set(res);
          this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x8000)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
        }
        else if (op === 0x34) {
          // XOR AL, imm8
          const imm = this.fetch8(); const al = this.reg8FromCode(0).get(); const res = (al ^ imm) & 0xFF; this.reg8FromCode(0).set(res);
          this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x80)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
        }
        else if (op === 0x35) {
          // XOR AX, imm16
          const imm = this.fetch16(); const ax = this.reg16FromCode(0).get(); const res = (ax ^ imm) & 0xFFFF; this.reg16FromCode(0).set(res);
          this.flags.CF = 0; this.flags.OF = 0; this.flags.ZF = (res===0)?1:0; this.flags.SF = (res & 0x8000)?1:0; this.flags.PF = this.parity(res&0xFF)?1:0;
        }
        else {
          this.onConsole(`[UNIMPLEMENTED OPCODE 0x${op.toString(16)} at ${this.segments.CS.toString(16)}:${(this.IP-1).toString(16)}]`);
          this.halted = true;
          this.onHalt(`unimplemented opcode ${op.toString(16)}`);
        }
        break;
    }
    this.onUpdate();
  }

  loadFromHexOrText(text, offsetHex=0x100) {
    const off = parseInt(offsetHex, 16) & 0xFFFF;
    const hexTokens = text.trim().split(/\s+/);
    let isHex = hexTokens.every(t => /^[0-9a-fA-F]{1,2}$/.test(t));
    if (isHex && hexTokens.length > 0) { let idx=0; for (const t of hexTokens) { this.write8(off + idx, parseInt(t,16)); idx++; } }
    else { for (let i=0;i<text.length;i++) this.write8(off + i, text.charCodeAt(i)); }
  }
}

// Export for browser global
if (typeof window !== 'undefined') window.CPU = CPU;
