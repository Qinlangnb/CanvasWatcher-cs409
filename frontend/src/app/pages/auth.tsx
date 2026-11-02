import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api";
import { BellIcon, ClipboardIcon, FolderIcon, LogoMark } from "../icons";
import { useSignIn, useSignUp } from "../queries";
import { Alert, Field, PasswordField, Spinner, usePageTitle } from "../ui";

const PASSWORD_MIN_LENGTH = 12;

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  usePageTitle(title);
  return (
    <div className="auth-layout">
      <section className="auth-intro" aria-label="About CanvasWatcher">
        <p className="brand">
          <LogoMark size={32} />
          <span>CanvasWatcher</span>
        </p>
        <p className="auth-tagline">Know what changed in Canvas before it catches you out.</p>
        <ul className="auth-points">
          <li>
            <ClipboardIcon />
            <span>Every assignment and due date from all your courses in one list.</span>
          </li>
          <li>
            <BellIcon />
            <span>A clear record when a due date moves, a file is replaced or an announcement is posted.</span>
          </li>
          <li>
            <FolderIcon />
            <span>Course files you can search and download without clicking through modules.</span>
          </li>
        </ul>
      </section>
      <main className="auth-panel" id="main">
        <div className="auth-card">
          <p className="brand auth-card-brand">
            <LogoMark />
            <span>CanvasWatcher</span>
          </p>
          <h1 tabIndex={-1} data-page-heading>
            {title}
          </h1>
          <p className="muted">{subtitle}</p>
          {children}
          <p className="auth-switch">{footer}</p>
        </div>
      </main>
    </div>
  );
}

/** Form errors from the server, plus the ones found before sending. */
function useFormErrors(error: unknown) {
  const [local, setLocal] = useState<Record<string, string>>({});
  const apiError = error instanceof ApiError ? error : null;
  return {
    fields: { ...apiError?.fields, ...local } as Record<string, string | undefined>,
    general: apiError && Object.keys(apiError.fields).length === 0 ? apiError.message : null,
    check(problems: Record<string, string>) {
      setLocal(problems);
      return Object.keys(problems).length === 0;
    },
  };
}

// After success the sign-in cache holds the user, and PublicOnly sends them on.

export function SignInPage() {
  const signIn = useSignIn();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const errors = useFormErrors(signIn.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!username.trim()) problems.username = "Enter your username or email.";
    if (!password) problems.password = "Enter your password.";
    if (errors.check(problems)) signIn.mutate({ username, password });
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Pick up where you left off."
      footer={
        <>
          New to CanvasWatcher? <Link to="/signup">Create an account</Link>
        </>
      }
    >
      <form className="stack" onSubmit={submit} noValidate>
        {errors.general ? <Alert>{errors.general}</Alert> : null}
        <Field
          label="Username or email"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          error={errors.fields.username}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.fields.password}
        />
        <button type="submit" className="button primary full" disabled={signIn.isPending}>
          {signIn.isPending ? <Spinner size={16} /> : null}
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthLayout>
  );
}

function passwordHint(password: string): string {
  if (!password) return `Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember.`;
  const missing = PASSWORD_MIN_LENGTH - password.length;
  if (missing > 0) return `${missing} more character${missing === 1 ? "" : "s"} needed.`;
  return "Long enough.";
}

export function SignUpPage() {
  const signUp = useSignUp();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errors = useFormErrors(signUp.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    const name = username.trim();
    if (name.length < 3) problems.username = "Use at least 3 characters.";
    else if (!/^[A-Za-z0-9_.-]+$/.test(name)) problems.username = "Use only letters, numbers, dots, dashes and underscores.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) problems.email = "Enter a valid email address.";
    if (password.length < PASSWORD_MIN_LENGTH) problems.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    if (errors.check(problems)) signUp.mutate({ username: name, email: email.trim(), password });
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="It takes a minute. Next you will connect Canvas."
      footer={
        <>
          Already have an account? <Link to="/signin">Sign in</Link>
        </>
      }
    >
      <form className="stack" onSubmit={submit} noValidate>
        {errors.general ? <Alert>{errors.general}</Alert> : null}
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          hint="Letters, numbers, dots, dashes or underscores."
          error={errors.fields.username}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.fields.email}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={passwordHint(password)}
          error={errors.fields.password}
        />
        <button type="submit" className="button primary full" disabled={signUp.isPending}>
          {signUp.isPending ? <Spinner size={16} /> : null}
          {signUp.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}
