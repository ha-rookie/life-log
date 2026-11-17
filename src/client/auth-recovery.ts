/**
 * Identify the Worker's private Owner-auth gate, not ordinary feature-denied
 * JSON responses. A 403 alone is not sufficient evidence of session expiry.
 */
export async function redirectOnExpiredOwnerSession(
  response:Response,
  navigate:(path:string)=>void = path=>window.location.replace(path)
):Promise<boolean>{
  if(response.status!==403)return false;
  const contentType=response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if(contentType!=="text/plain")return false;
  try{
    // Clone so normal callers can still read the original response.
    if(await response.clone().text()!=="Forbidden")return false;
  }catch{return false;}
  navigate("/login");
  return true;
}
