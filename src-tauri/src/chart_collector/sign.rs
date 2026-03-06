//! 长江e+公共服务平台 API 签名生成器
//! 签名算法: MD5(参数字符串 + 盐值).toUpperCase()

use md5::{Digest, Md5};

/// 硬编码盐值（从前端JS源码提取）
const SALT: &str = "C38568FF5709EDBEFF9F6EC9373069F8";

/// 为航标 API 生成签名
///
/// 参数按字母序排列拼接:
/// `lat1={v}&lat2={v}&lon1={v}&lon2={v}&organizationId={v}&timeStamp={v}&uid={v}{SALT}`
///
/// 注意：盐值直接拼接在 uid= 值后面，无 & 分隔
pub fn generate_buoy_sign(
    lon1: f64,
    lat1: f64,
    lon2: f64,
    lat2: f64,
    organization_id: &str,
    timestamp: u64,
    uid: &str,
) -> String {
    let sign_str = format!(
        "lat1={}&lat2={}&lon1={}&lon2={}&organizationId={}&timeStamp={}&uid={}{}",
        lat1, lat2, lon1, lon2, organization_id, timestamp, uid, SALT
    );

    let mut hasher = Md5::new();
    hasher.update(sign_str.as_bytes());
    let result = hasher.finalize();

    // 转为大写十六进制
    format!("{:X}", result)
}

/// 构建完整的航标 API URL
#[allow(dead_code)]
pub fn build_buoy_api_url(
    lon1: f64,
    lat1: f64,
    lon2: f64,
    lat2: f64,
    organization_id: &str,
    uid: &str,
) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let sign = generate_buoy_sign(lon1, lat1, lon2, lat2, organization_id, timestamp, uid);

    format!(
        "https://www.cjhy.com.cn/eweb/api/buoyService/getAllBuoyInfoByRectUid?\
        lon1={}&lat1={}&lon2={}&lat2={}&organizationId={}&timeStamp={}&uid={}&sign={}",
        lon1, lat1, lon2, lat2, organization_id, timestamp, uid, sign
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sign_generation() {
        // 使用用户提供的已知参数验证
        let sign = generate_buoy_sign(
            113.05403505095798,
            29.463609778332252,
            113.12600408324558,
            29.50086029713108,
            "100001",
            1772514532819,
            "",
        );

        // 已知签名值 (来自用户提供的URL)
        let expected = "B6328BD1467AA1B0C34A3AF02F2551B5";

        println!("Generated sign: {}", sign);
        println!("Expected sign:  {}", expected);

        // 如果签名匹配，说明算法正确
        // 如果不匹配，需要调整参数拼接顺序或盐值
        assert_eq!(sign, expected, "签名不匹配！可能需要调整参数拼接顺序或盐值");
    }

    #[test]
    fn test_build_url() {
        let url = build_buoy_api_url(113.05, 29.46, 113.13, 29.50, "100001", "");
        assert!(url.contains("getAllBuoyInfoByRectUid"));
        assert!(url.contains("sign="));
        assert!(url.contains("timeStamp="));
    }
}
