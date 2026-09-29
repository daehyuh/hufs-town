package town.hufs.api.space;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Bound map parsing memory, including requests sent without a Content-Length. Runs after Spring Security. */
@Component
class MapBodyLimit extends OncePerRequestFilter {
    static final int LIMIT=512_000;
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getMethod().equals("POST") || !request.getRequestURI().matches("/api/v1/spaces/[^/]+/map(?:/.*)?|/api/v1/spaces/[^/]+/maps/[^/]+/edit(?:/.*)?");
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        if(request.getContentLengthLong()>LIMIT){reject(response);return;}
        byte[] body=request.getInputStream().readNBytes(LIMIT+1);
        if(body.length>LIMIT){reject(response);return;}
        chain.doFilter(new HttpServletRequestWrapper(request){
            @Override public ServletInputStream getInputStream(){var input=new ByteArrayInputStream(body);return new ServletInputStream(){
                @Override public int read(){return input.read();}
                @Override public int read(byte[] b,int offset,int length){return input.read(b,offset,length);}
                @Override public boolean isFinished(){return input.available()==0;}
                @Override public boolean isReady(){return true;}
                @Override public void setReadListener(ReadListener listener){throw new UnsupportedOperationException("Synchronous JSON endpoint");}
            };}
            @Override public BufferedReader getReader(){return new BufferedReader(new InputStreamReader(getInputStream(),StandardCharsets.UTF_8));}
        },response);
    }
    private void reject(HttpServletResponse response)throws IOException{response.setStatus(413);response.setContentType("application/json;charset=UTF-8");response.getWriter().write("{\"code\":\"MAP_TOO_LARGE\",\"message\":\"512KB 이하의 맵을 저장해 주세요.\"}");}
}
