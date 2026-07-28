import { Toaster as Sonner, type ToasterProps } from "sonner"
// Imported statically so the styles ship in the app's own stylesheet. Sonner's
// runtime-injected <style> tag is blocked by the Content-Security-Policy
// (style-src 'self'), which leaves toasts completely unstyled.
import "sonner/dist/styles.css"

const Toaster = ({ ...props }: ToasterProps) => {
  return <Sonner theme="light" className="toaster group" {...props} />
}

export { Toaster }
