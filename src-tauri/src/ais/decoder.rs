//! 极简 AIVDM/AIVDO 解码器。
//! 解码单帧船位报文（type 1/2/3/18/19）与 Class B 静态名（type 24A、type 19 内含名）。
//! 多帧报文（实测 <1%，多为 Class A 静态名 type 5）暂跳过——船位报文均为单帧，覆盖率足够。
//! 经 600 条真实样本与独立 JS 实现交叉验证一致。

/// 解码结果
pub enum Decoded {
    Position {
        mmsi: u32,
        lat: f64,
        lon: f64,
        sog: Option<f64>,
        cog: Option<f64>,
        heading: Option<f64>,
        nav_status: Option<u8>,
        name: Option<String>,
    },
    Name {
        mmsi: u32,
        name: String,
    },
    Other,
}

fn sixbit(c: u8) -> Option<u8> {
    if c < 48 {
        return None;
    }
    let mut v = c - 48;
    if v > 40 {
        v -= 8;
    }
    if v > 63 {
        None
    } else {
        Some(v)
    }
}

/// 把 6-bit ASCII 载荷展开成位数组（每元素 0/1）。
struct Bits {
    v: Vec<u8>,
}

impl Bits {
    fn from_payload(p: &str) -> Option<Bits> {
        let mut v = Vec::with_capacity(p.len() * 6);
        for &c in p.as_bytes() {
            let s = sixbit(c)?;
            for i in (0..6).rev() {
                v.push((s >> i) & 1);
            }
        }
        Some(Bits { v })
    }

    fn len(&self) -> usize {
        self.v.len()
    }

    fn u(&self, a: usize, n: usize) -> u64 {
        let mut r = 0u64;
        for i in 0..n {
            r = (r << 1) | self.v[a + i] as u64;
        }
        r
    }

    fn i(&self, a: usize, n: usize) -> i64 {
        let mut r = self.u(a, n) as i64;
        if self.v[a] == 1 {
            r -= 1i64 << n;
        }
        r
    }

    /// 读 `chars` 个 6-bit 字符为字符串（AIS 6-bit ASCII），去掉尾部 @ 与空格。
    fn text(&self, a: usize, chars: usize) -> String {
        let mut s = String::new();
        for k in 0..chars {
            let off = a + k * 6;
            if off + 6 > self.v.len() {
                break;
            }
            let val = self.u(off, 6) as u8;
            let ch = if val < 32 { (val + 64) as char } else { val as char };
            s.push(ch);
        }
        s.trim_end_matches(|c| c == '@' || c == ' ').to_string()
    }
}

pub fn decode(sentence: &str) -> Decoded {
    let idx = match sentence.find("!AIV") {
        Some(i) => i,
        None => return Decoded::Other,
    };
    let parts: Vec<&str> = sentence[idx..].split(',').collect();
    if parts.len() < 6 {
        return Decoded::Other;
    }
    // 只处理单帧（fragCount=1, fragNum=1）
    if parts[1] != "1" || parts[2] != "1" {
        return Decoded::Other;
    }
    let payload = parts[5];
    if payload.is_empty() {
        return Decoded::Other;
    }
    let bits = match Bits::from_payload(payload) {
        Some(b) => b,
        None => return Decoded::Other,
    };
    if bits.len() < 38 {
        return Decoded::Other;
    }

    match bits.u(0, 6) {
        1 | 2 | 3 => {
            if bits.len() < 137 {
                return Decoded::Other;
            }
            let mmsi = bits.u(8, 30) as u32;
            let nav = bits.u(38, 4) as u8;
            let sog = bits.u(50, 10);
            let lon = bits.i(61, 28) as f64 / 600000.0;
            let lat = bits.i(89, 27) as f64 / 600000.0;
            let cog = bits.u(116, 12);
            let hdg = bits.u(128, 9);
            mk_position(mmsi, lat, lon, sog, cog, hdg, Some(nav), None)
        }
        18 => {
            if bits.len() < 133 {
                return Decoded::Other;
            }
            let mmsi = bits.u(8, 30) as u32;
            let sog = bits.u(46, 10);
            let lon = bits.i(57, 28) as f64 / 600000.0;
            let lat = bits.i(85, 27) as f64 / 600000.0;
            let cog = bits.u(112, 12);
            let hdg = bits.u(124, 9);
            mk_position(mmsi, lat, lon, sog, cog, hdg, None, None)
        }
        19 => {
            if bits.len() < 133 {
                return Decoded::Other;
            }
            let mmsi = bits.u(8, 30) as u32;
            let sog = bits.u(46, 10);
            let lon = bits.i(57, 28) as f64 / 600000.0;
            let lat = bits.i(85, 27) as f64 / 600000.0;
            let cog = bits.u(112, 12);
            let hdg = bits.u(124, 9);
            let name = if bits.len() >= 263 {
                let n = bits.text(143, 20);
                if n.is_empty() {
                    None
                } else {
                    Some(n)
                }
            } else {
                None
            };
            mk_position(mmsi, lat, lon, sog, cog, hdg, None, name)
        }
        24 => {
            if bits.len() < 40 {
                return Decoded::Other;
            }
            let mmsi = bits.u(8, 30) as u32;
            let partno = bits.u(38, 2);
            if partno == 0 && bits.len() >= 160 {
                let name = bits.text(40, 20);
                if name.is_empty() {
                    Decoded::Other
                } else {
                    Decoded::Name { mmsi, name }
                }
            } else {
                Decoded::Other
            }
        }
        _ => Decoded::Other,
    }
}

#[allow(clippy::too_many_arguments)]
fn mk_position(
    mmsi: u32,
    lat: f64,
    lon: f64,
    sog_raw: u64,
    cog_raw: u64,
    hdg_raw: u64,
    nav: Option<u8>,
    name: Option<String>,
) -> Decoded {
    if lat.abs() > 90.0 || lon.abs() > 180.0 || (lat == 0.0 && lon == 0.0) {
        return Decoded::Other;
    }
    Decoded::Position {
        mmsi,
        lat,
        lon,
        sog: if sog_raw == 1023 {
            None
        } else {
            Some(sog_raw as f64 / 10.0)
        },
        cog: if cog_raw == 3600 {
            None
        } else {
            Some(cog_raw as f64 / 10.0)
        },
        heading: if hdg_raw == 511 {
            None
        } else {
            Some(hdg_raw as f64)
        },
        nav_status: nav,
        name,
    }
}
