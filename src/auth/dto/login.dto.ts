import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /**
   * Lowercased and trimmed so the unique index on account.email is the real
   * uniqueness rule rather than a case-sensitive approximation of it.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  /** Bounded so an unauthenticated caller cannot ask for unbounded hashing work. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
