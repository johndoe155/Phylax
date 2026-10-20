import type { PoolClient } from "pg";

/** Typed, unverified email credentials are provisional. Adding email to a passkey-only account instead
 * requires that account's fresh authenticated session at the confirmation route. */
export async function establishEmailOwnership(client: PoolClient, accountId: string, email: string) {
 const result=await client.query<{email_verified:boolean;email:string|null}>("SELECT email,email_verified FROM accounts WHERE id=$1 FOR UPDATE",[accountId]);
 const account=result.rows[0];if(!account)throw new Error("account disappeared");
 if(!account.email_verified && account.email!==null){
  for(const table of ["account_consents","auth_identities","webauthn_challenges","phone_verifications","passkeys","sessions","password_reset_tokens"]){
   await client.query(`DELETE FROM ${table} WHERE account_id=$1`,[accountId]); // fixed internal table list, never user input
  }
  await client.query("UPDATE accounts SET phone=NULL,phone_verified=false WHERE id=$1",[accountId]);
  await client.query("UPDATE account_settings SET phone=NULL,sms_enabled=false,email_enabled=false WHERE account_id=$1",[accountId]);
 }
 await client.query("INSERT INTO auth_identities(account_id,method) VALUES($1,'link') ON CONFLICT DO NOTHING",[accountId]);
 await client.query("UPDATE accounts SET email=$2,email_verified=true,email_verified_at=now() WHERE id=$1",[accountId,email]);
}
